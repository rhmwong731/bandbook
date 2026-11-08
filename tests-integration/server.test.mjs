// Integration test against a running local worker:  npx wrangler dev --local --port 8787
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:8787';
const call = async (method, path, { token, body, raw, headers = {} } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
const id = () => 's' + Math.random().toString(36).slice(2, 12);

// --- joining
assert.equal((await call('GET', '/api/health')).status, 200);
assert.equal((await call('GET', '/api/sync')).status, 401, 'needs a token');
assert.equal((await call('POST', '/api/join', { body: { name: 'X', code: 'nope' } })).status, 403);
assert.equal((await call('POST', '/api/join', { body: { name: '', code: 'testcode' } })).status, 400);
const A = (await call('POST', '/api/join', { body: { name: 'Raph', code: 'testcode' } })).data;
const B = (await call('POST', '/api/join', { body: { name: 'Sam', code: 'testcode' } })).data;
assert.ok(A.token && B.token && A.token !== B.token);
assert.equal((await call('GET', '/api/me', { token: A.token })).data.member.name, 'Raph');
assert.equal((await call('GET', '/api/me', { token: 'f'.repeat(64) })).status, 401);

// --- songs: create, pull, edit, conflict, folder move
const s1 = id();
let r = await call('PUT', '/api/songs/' + s1, { token: A.token, body: { baseRev: 0, kind: 'cho', title: 'One', text: '{title: One}\n[G]hi', folder: 'Originals' } });
assert.equal(r.data.rev, 1);
let pull = (await call('GET', '/api/sync?since=0', { token: B.token })).data;
const got = pull.songs.find((s) => s.id === s1);
assert.equal(got.title, 'One');
assert.equal(got.folder, 'Originals');
assert.match(got.text, /\[G\]hi/);
const cursor = pull.seq;
r = await call('PUT', '/api/songs/' + s1, { token: B.token, body: { baseRev: 1, kind: 'cho', title: 'One', text: 'B edit', folder: 'Originals' } });
assert.equal(r.data.rev, 2);
r = await call('PUT', '/api/songs/' + s1, { token: A.token, body: { baseRev: 1, kind: 'cho', title: 'One', text: 'A stale edit', folder: 'Originals' } });
assert.equal(r.status, 409, 'stale edit is a conflict');
assert.equal(r.data.current.text, 'B edit');
pull = (await call('GET', '/api/sync?since=' + cursor, { token: A.token })).data;
assert.deepEqual(pull.songs.map((s) => s.id), [s1], 'only changes since the cursor');
assert.equal((await call('GET', '/api/sync?since=' + pull.seq, { token: A.token })).data.songs.length, 0);
r = await call('PUT', '/api/songs/' + s1, { token: A.token, body: { baseRev: 2, kind: 'cho', title: 'One', text: 'B edit', folder: 'Covers' } });
assert.equal(r.data.rev, 3);

// --- PDF files
const d1 = id();
await call('PUT', '/api/songs/' + d1, { token: A.token, body: { baseRev: 0, kind: 'pdf', title: 'Chart', mime: 'application/pdf', file_name: 'Chart.pdf', text: 'ignored' } });
assert.equal((await call('PUT', '/api/files/' + s1, { token: A.token, raw: Buffer.from('x') })).status, 404, 'no file for a text song');
const bytes = Buffer.from([37, 80, 68, 70, 0, 255, 128, 10]);
r = await call('PUT', '/api/files/' + d1, { token: A.token, raw: bytes, headers: { 'X-Mime': 'application/pdf', 'Content-Type': 'application/octet-stream' } });
assert.equal(r.data.rev, 2);
r = await call('GET', '/api/files/' + d1, { token: B.token });
assert.deepEqual([...r.data], [...bytes]);
pull = (await call('GET', '/api/sync?since=0', { token: B.token })).data;
const doc = pull.songs.find((s) => s.id === d1);
assert.equal(doc.kind, 'pdf'); assert.equal(doc.text, ''); assert.equal(doc.rev, 2);
assert.equal((await call('GET', '/api/files/' + d1)).status, 401);
assert.equal((await call('GET', '/api/files/' + id(), { token: A.token })).status, 404);

// --- delete is a tombstone
await call('DELETE', '/api/songs/' + d1, { token: B.token });
pull = (await call('GET', '/api/sync?since=0', { token: A.token })).data;
assert.equal(pull.songs.find((s) => s.id === d1).deleted, 1);
assert.equal((await call('GET', '/api/files/' + d1, { token: A.token })).status, 404);

// --- set lists
const l1 = id();
r = await call('PUT', '/api/setlists/' + l1, { token: A.token, body: { baseRev: 0, name: 'Gig', json: '{"items":[]}' } });
assert.equal(r.data.rev, 1);
r = await call('PUT', '/api/setlists/' + l1, { token: B.token, body: { baseRev: 0, name: 'Gig', json: '{}' } });
assert.equal(r.status, 409);
r = await call('PUT', '/api/setlists/' + l1, { token: B.token, body: { baseRev: 1, name: 'Gig 2', json: '{"items":[1]}' } });
assert.equal(r.data.rev, 2);
pull = (await call('GET', '/api/sync?since=0', { token: A.token })).data;
assert.equal(pull.setlists.find((x) => x.id === l1).name, 'Gig 2');

// --- annotations are private
await call('PUT', '/api/ink/' + s1, { token: A.token, body: { json: JSON.stringify({ strokes: ['a'] }) } });
await call('PUT', '/api/ink/' + s1, { token: B.token, body: { json: JSON.stringify({ strokes: ['b'] }) } });
const inkA = (await call('GET', '/api/sync?since=0', { token: A.token })).data.ink;
const inkB = (await call('GET', '/api/sync?since=0', { token: B.token })).data.ink;
assert.equal(inkA.length, 1); assert.equal(inkB.length, 1);
assert.deepEqual(JSON.parse(inkA[0].json).strokes, ['a']);
assert.deepEqual(JSON.parse(inkB[0].json).strokes, ['b']);

// --- folders merge
r = await call('PUT', '/api/folders', { token: A.token, body: { folders: ['Originals', 'Medleys'] } });
r = await call('PUT', '/api/folders', { token: B.token, body: { folders: ['Covers', 'Originals'] } });
assert.deepEqual(r.data.folders, ['Originals', 'Medleys', 'Covers']);

// --- validation
assert.equal((await call('PUT', '/api/songs/bad%20id', { token: A.token, body: {} })).status, 404);
assert.equal((await call('PUT', '/api/songs/abc', { token: A.token, body: {} })).status, 400, 'ids must be 6+ chars');
assert.equal((await call('PUT', '/api/songs/' + id(), { token: A.token, raw: 'not json', headers: { 'Content-Type': 'application/json' } })).status, 400);
assert.equal((await call('PUT', '/api/files/' + s1, { token: A.token, raw: 'x' })).status, 404);

// --- admin: list and remove members
assert.equal((await call('GET', '/api/members')).status, 403);
assert.equal((await call('GET', '/api/members', { headers: { 'X-Admin-Code': 'wrong' } })).status, 403);
const list = (await call('GET', '/api/members', { headers: { 'X-Admin-Code': 'adminpass' } })).data.members;
assert.ok(list.some((m) => m.id === B.member.id));
assert.equal((await call('DELETE', '/api/members/' + B.member.id, { headers: { 'X-Admin-Code': 'adminpass' } })).status, 200);
assert.equal((await call('GET', '/api/sync', { token: B.token })).status, 401, 'removed member is locked out');
assert.equal((await call('GET', '/api/sync', { token: A.token })).status, 200);

// --- join rate limit
let limited = false;
for (let i = 0; i < 10; i++) if ((await call('POST', '/api/join', { body: { name: 'X', code: 'bad' + i } })).status === 429) limited = true;
assert.ok(limited, 'repeated wrong codes get rate limited');

console.log('server integration tests passed');
