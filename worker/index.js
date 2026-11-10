// BandBook server: one Cloudflare Worker that serves the app (static assets) and the band's shared data.
//   D1  (env.DB)     members, charts, set lists, private annotations
//   KV  (env.FILES)  PDF / image files, join rate-limit counters
//   Secrets          INVITE_CODE (to join), ADMIN_CODE (optional, to remove members)
//   Variable         BAND_NAME
// Auth: joining with the invite code returns a personal token; every other call sends it as "Authorization: Bearer ...".

const MAX_TEXT = 512 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_INK = 4 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Admin-Code, X-Mime, X-Name',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });
const fail = (status, error) => json({ error }, status);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const newToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const newId = () => hex(crypto.getRandomValues(new Uint8Array(9)));

async function same(a, b) { // constant-time-ish compare of two secrets
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

async function nextSeq(env) {
  const r = await env.DB.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'seq' RETURNING value").first();
  return Number(r.value);
}

async function authenticate(req, env) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer ([0-9a-f]{64})$/);
  if (!m) return null;
  await ensureOwnerColumn(env);
  // a linked device (owner set) acts as its owner: same member id, so same private annotations
  return env.DB.prepare('SELECT COALESCE(m.owner, m.id) AS id, m.name AS name FROM members m LEFT JOIN members o ON o.id = m.owner WHERE m.token_hash = ? AND m.revoked = 0 AND (m.owner IS NULL OR o.revoked = 0)').bind(await sha256(m[1])).first();
}

// Databases made before "link another device" get the extra column the first time the server runs.
let ownerReady = false;
async function ensureOwnerColumn(env) {
  if (ownerReady) return;
  try { await env.DB.prepare('ALTER TABLE members ADD COLUMN owner TEXT').run(); } catch { /* already there */ }
  ownerReady = true;
}

async function readJson(req, limit) {
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, 'Too large');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Bad JSON'); }
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const str = (v, max, d = '') => (typeof v === 'string' ? v.slice(0, max) : d);

// ---------- handlers ----------

// failed-guess limiter: 8 wrong codes per 10 minutes per address, separately for joining and admin
async function guessGate(req, env, kind) {
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const key = `rl:${kind}:${ip}`;
  const tries = Number((await env.FILES.get(key)) || 0);
  return {
    blocked: tries >= 8,
    miss: () => env.FILES.put(key, String(tries + 1), { expirationTtl: 600 }),
  };
}

const LINK_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
async function makeLink(env, me) {
  const code = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => LINK_ALPHABET[b % LINK_ALPHABET.length]).join('');
  await env.FILES.put('link:' + code, me.id, { expirationTtl: 600 });
  return json({ code, minutes: 10 });
}

async function join(req, env) {
  const gate = await guessGate(req, env, 'join');
  if (gate.blocked) return fail(429, 'Too many tries. Wait ten minutes and try again.');
  const body = await readJson(req, 2000);
  if (body.link) { // second device for an existing member: needs the one-time code made on the first device
    await ensureOwnerColumn(env);
    const key = 'link:' + str(body.link, 20).trim().toLowerCase();
    const ownerId = await env.FILES.get(key);
    const owner = ownerId && (await env.DB.prepare('SELECT id, name FROM members WHERE id = ? AND revoked = 0 AND owner IS NULL').bind(ownerId).first());
    if (!owner) { await gate.miss(); return fail(403, 'That link code is not right, or it has run out. Make a new one on your other device.'); }
    await env.FILES.delete(key);
    const token = newToken();
    await env.DB.prepare('INSERT INTO members (id, name, token_hash, created, owner) VALUES (?, ?, ?, ?, ?)').bind(newId(), owner.name, await sha256(token), Date.now(), owner.id).run();
    return json({ token, member: { id: owner.id, name: owner.name }, band: env.BAND_NAME || 'Band' });
  }
  const name = str(body.name, 40).trim();
  if (!name) return fail(400, 'Enter your name.');
  if (!env.INVITE_CODE) return fail(500, 'The server has no invite code set up.');
  if (!(await same(str(body.code, 100).trim(), env.INVITE_CODE))) {
    await gate.miss();
    return fail(403, 'That invite code is not right.');
  }
  const token = newToken();
  const id = newId();
  await env.DB.prepare('INSERT INTO members (id, name, token_hash, created) VALUES (?, ?, ?, ?)').bind(id, name, await sha256(token), Date.now()).run();
  return json({ token, member: { id, name }, band: env.BAND_NAME || 'Band' });
}

async function syncPull(url, env, me) {
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const [songs, sets, ink, folders, seq] = await Promise.all([
    env.DB.prepare('SELECT id, folder, title, kind, CASE WHEN kind = \'cho\' THEN text ELSE \'\' END AS text, mime, file_name, rev, deleted, updated_by FROM songs WHERE seq > ?').bind(since).all(),
    env.DB.prepare('SELECT id, name, json, rev, deleted FROM setlists WHERE seq > ?').bind(since).all(),
    env.DB.prepare('SELECT song_id, json FROM ink WHERE member_id = ? AND seq > ?').bind(me.id, since).all(),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'folders'").first(),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'seq'").first(),
  ]);
  return json({ seq: Number(seq.value), songs: songs.results, setlists: sets.results, ink: ink.results, folders: JSON.parse(folders.value) });
}

// Version history: the last HISTORY_KEEP texts of every chart, so a bad edit can be rolled back.
const HISTORY_KEEP = 20;
let historyReady = false;
async function ensureHistory(env) {
  if (historyReady) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS song_versions (song_id TEXT NOT NULL, rev INTEGER NOT NULL, title TEXT, text TEXT NOT NULL, by TEXT, at INTEGER NOT NULL, PRIMARY KEY (song_id, rev))').run();
  historyReady = true;
}
async function saveVersion(env, id, rev, title, text, by, at) {
  try {
    await ensureHistory(env);
    await env.DB.prepare('INSERT OR REPLACE INTO song_versions (song_id, rev, title, text, by, at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, rev, title, text, by, at).run();
    await env.DB.prepare('DELETE FROM song_versions WHERE song_id = ? AND rev <= ?').bind(id, rev - HISTORY_KEEP).run();
  } catch { /* history is a safety net: never block a save */ }
}
async function songHistory(env, id, rev) {
  await ensureHistory(env);
  if (rev) {
    const r = await env.DB.prepare('SELECT rev, title, text, by, at FROM song_versions WHERE song_id = ? AND rev = ?').bind(id, Number(rev)).first();
    return r ? json({ version: r }) : fail(404, 'That version is no longer kept.');
  }
  const rows = await env.DB.prepare('SELECT rev, title, by, at, length(text) AS size FROM song_versions WHERE song_id = ? ORDER BY rev DESC').bind(id).all();
  return json({ versions: rows.results });
}

async function putSong(req, env, me, id) {
  const b = await readJson(req, MAX_TEXT + 4000);
  const kind = ['cho', 'pdf', 'image'].includes(b.kind) ? b.kind : 'cho';
  const text = kind === 'cho' ? str(b.text, MAX_TEXT) : '';
  const folder = str(b.folder, 60).trim();
  const title = str(b.title, 200) || 'Untitled';
  const cur = await env.DB.prepare('SELECT rev, deleted FROM songs WHERE id = ?').bind(id).first();
  const seq = await nextSeq(env);
  const now = Date.now();
  if (!cur) {
    await env.DB.prepare('INSERT INTO songs (id, folder, title, kind, text, mime, file_name, rev, seq, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
      .bind(id, folder, title, kind, text, str(b.mime, 100) || null, str(b.file_name, 200) || null, seq, me.name, now).run();
    if (kind === 'cho') await saveVersion(env, id, 1, title, text, me.name, now);
    return json({ rev: 1, seq });
  }
  if (Number(b.baseRev || 0) !== cur.rev) {
    const row = await env.DB.prepare('SELECT id, folder, title, kind, text, mime, file_name, rev, deleted FROM songs WHERE id = ?').bind(id).first();
    return json({ error: 'conflict', current: row }, 409);
  }
  const rev = cur.rev + 1;
  await env.DB.prepare('UPDATE songs SET folder = ?, title = ?, kind = ?, text = ?, mime = COALESCE(?, mime), file_name = COALESCE(?, file_name), rev = ?, seq = ?, deleted = 0, updated_by = ?, updated_at = ? WHERE id = ?')
    .bind(folder, title, kind, text, str(b.mime, 100) || null, str(b.file_name, 200) || null, rev, seq, me.name, now, id).run();
  if (kind === 'cho') await saveVersion(env, id, rev, title, text, me.name, now);
  return json({ rev, seq });
}

async function deleteSong(env, me, id) {
  const cur = await env.DB.prepare('SELECT rev FROM songs WHERE id = ?').bind(id).first();
  if (!cur) return json({ ok: true });
  const seq = await nextSeq(env);
  await env.DB.prepare("UPDATE songs SET deleted = 1, text = '', rev = rev + 1, seq = ?, updated_by = ?, updated_at = ? WHERE id = ?").bind(seq, me.name, Date.now(), id).run();
  try { await ensureHistory(env); await env.DB.prepare('DELETE FROM song_versions WHERE song_id = ?').bind(id).run(); } catch { /* ignore */ }
  await env.FILES.delete('f:' + id);
  return json({ ok: true });
}

async function putFile(req, env, me, id) {
  const song = await env.DB.prepare('SELECT rev, kind FROM songs WHERE id = ? AND deleted = 0').bind(id).first();
  if (!song || song.kind === 'cho') return fail(404, 'Create the song first.');
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_FILE) return fail(413, 'That file is over 20 MB.');
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_FILE) return fail(413, 'That file is over 20 MB.');
  const mime = str(req.headers.get('X-Mime'), 100) || 'application/octet-stream';
  await env.FILES.put('f:' + id, buf, { metadata: { mime } });
  const seq = await nextSeq(env);
  const rev = song.rev + 1;
  await env.DB.prepare('UPDATE songs SET rev = ?, seq = ?, mime = ?, updated_by = ?, updated_at = ? WHERE id = ?').bind(rev, seq, mime, me.name, Date.now(), id).run();
  return json({ rev, seq });
}

async function getFile(env, id) {
  const { value, metadata } = await env.FILES.getWithMetadata('f:' + id, 'arrayBuffer');
  if (!value) return fail(404, 'No such file');
  return new Response(value, { headers: { 'Content-Type': metadata?.mime || 'application/octet-stream', 'Cache-Control': 'no-store', ...CORS } });
}

async function putSetlist(req, env, me, id) {
  const b = await readJson(req, 200 * 1024);
  const cur = await env.DB.prepare('SELECT rev FROM setlists WHERE id = ?').bind(id).first();
  const seq = await nextSeq(env);
  const name = str(b.name, 120) || 'Set';
  const body = typeof b.json === 'string' ? b.json.slice(0, 150 * 1024) : '{}';
  if (!cur) {
    await env.DB.prepare('INSERT INTO setlists (id, name, json, rev, seq, updated_by, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)').bind(id, name, body, seq, me.name, Date.now()).run();
    return json({ rev: 1, seq });
  }
  if (Number(b.baseRev || 0) !== cur.rev) {
    const row = await env.DB.prepare('SELECT id, name, json, rev, deleted FROM setlists WHERE id = ?').bind(id).first();
    return json({ error: 'conflict', current: row }, 409);
  }
  await env.DB.prepare('UPDATE setlists SET name = ?, json = ?, rev = ?, seq = ?, deleted = 0, updated_by = ?, updated_at = ? WHERE id = ?').bind(name, body, cur.rev + 1, seq, me.name, Date.now(), id).run();
  return json({ rev: cur.rev + 1, seq });
}

async function deleteSetlist(env, me, id) {
  const seq = await nextSeq(env);
  await env.DB.prepare("UPDATE setlists SET deleted = 1, json = '{}', rev = rev + 1, seq = ?, updated_by = ?, updated_at = ? WHERE id = ?").bind(seq, me.name, Date.now(), id).run();
  return json({ ok: true });
}

async function putInk(req, env, me, songId) {
  const b = await readJson(req, MAX_INK);
  const body = typeof b.json === 'string' ? b.json : JSON.stringify(b.json || {});
  if (body.length > MAX_INK) return fail(413, 'Too many annotations on one song.');
  const seq = await nextSeq(env);
  await env.DB.prepare('INSERT INTO ink (member_id, song_id, json, seq, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(member_id, song_id) DO UPDATE SET json = excluded.json, seq = excluded.seq, updated_at = excluded.updated_at')
    .bind(me.id, songId, body, seq, Date.now()).run();
  return json({ seq });
}

async function putFolders(req, env) {
  const b = await readJson(req, 10000);
  const list = Array.isArray(b.folders) ? b.folders.map((f) => str(f, 60).trim()).filter(Boolean) : [];
  const cur = JSON.parse((await env.DB.prepare("SELECT value FROM meta WHERE key = 'folders'").first()).value);
  const merged = [...cur];
  for (const f of list) if (!merged.includes(f) && merged.length < 60) merged.push(f);
  await env.DB.prepare("UPDATE meta SET value = ? WHERE key = 'folders'").bind(JSON.stringify(merged)).run();
  return json({ folders: merged });
}

async function admin(req, env, url) {
  await ensureOwnerColumn(env);
  const gate = await guessGate(req, env, 'admin');
  if (gate.blocked) return fail(429, 'Too many tries. Wait ten minutes and try again.');
  if (!env.ADMIN_CODE || !(await same(req.headers.get('X-Admin-Code') || '', env.ADMIN_CODE))) { await gate.miss(); return fail(403, 'Admin code needed.'); }
  if (req.method === 'GET') {
    const r = await env.DB.prepare('SELECT id, name, created FROM members WHERE revoked = 0 AND owner IS NULL ORDER BY created').all();
    return json({ members: r.results });
  }
  const m = url.pathname.match(/^\/api\/members\/([A-Za-z0-9_-]+)$/);
  if (req.method === 'DELETE' && m) {
    await env.DB.prepare('UPDATE members SET revoked = 1 WHERE id = ? OR owner = ?').bind(m[1], m[1]).run();
    return json({ ok: true });
  }
  return fail(404, 'Not found');
}

// ---------- router ----------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      const p = url.pathname;
      const M = req.method;
      if (p === '/api/health') return json({ ok: true });
      if (p === '/api/join' && M === 'POST') return await join(req, env);
      if (p === '/api/members' || p.startsWith('/api/members/')) return await admin(req, env, url);

      const me = await authenticate(req, env);
      if (!me) return fail(401, 'Not signed in to the band.');
      if (p === '/api/link' && M === 'POST') return await makeLink(env, me);
      if (p === '/api/me') return json({ member: me, band: env.BAND_NAME || 'Band' });
      if (p === '/api/sync' && M === 'GET') return await syncPull(url, env, me);
      if (p === '/api/folders' && M === 'PUT') return await putFolders(req, env);

      let m;
      if ((m = p.match(/^\/api\/songs\/([A-Za-z0-9_-]+)\/history(?:\/(\d+))?$/)) && M === 'GET') {
        if (!ID_RE.test(m[1])) return fail(400, 'Bad id');
        return await songHistory(env, m[1], m[2]);
      }
      if ((m = p.match(/^\/api\/(songs|files|setlists|ink)\/([A-Za-z0-9_-]+)$/))) {
        const [, kind, id] = m;
        if (!ID_RE.test(id)) return fail(400, 'Bad id');
        if (kind === 'songs') { if (M === 'PUT') return await putSong(req, env, me, id); if (M === 'DELETE') return await deleteSong(env, me, id); }
        if (kind === 'files') { if (M === 'PUT') return await putFile(req, env, me, id); if (M === 'GET') return await getFile(env, id); }
        if (kind === 'setlists') { if (M === 'PUT') return await putSetlist(req, env, me, id); if (M === 'DELETE') return await deleteSetlist(env, me, id); }
        if (kind === 'ink' && M === 'PUT') return await putInk(req, env, me, id);
      }
      return fail(404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message);
      return fail(500, 'Server error');
    }
  },
};
