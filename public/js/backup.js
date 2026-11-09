// Backup / restore of everything on this device: songs, PDFs/images, annotations, set lists, folder list and display prefs.
// One JSON file; binary files are base64. Restore either merges (newer wins, nothing deleted) or replaces everything.
import * as db from './store.js';

const SETTING_KEYS = ['folders', 'collapsed', 'voicings', 'instrument', 'chordStyle', 'darkPage', 'penOnly', 'metroVolume', 'metroFlash', 'nightMode', 'countIn', 'gapDefault'];

async function toB64(blob) {
  const u = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(bin);
}
const fromB64 = (b64, type) => {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type });
};

export async function buildBackup() {
  const files = [];
  for (const f of await db.all('files')) files.push({ id: f.id, name: f.name, mime: f.mime, data: await toB64(f.blob) });
  const settings = {};
  for (const k of SETTING_KEYS) { const v = db.settings.get(k, undefined); if (v !== undefined) settings[k] = v; }
  return {
    app: 'bandbook',
    v: 1,
    exportedAt: Date.now(),
    songs: await db.all('songs'),
    ink: await db.all('ink'),
    setlists: await db.all('setlists'),
    files,
    settings,
  };
}

export const backupName = () => `bandbook-backup-${new Date().toISOString().slice(0, 10)}.json`;

export function validate(j) {
  if (!j || j.app !== 'bandbook' || !Array.isArray(j.songs)) throw new Error('That file is not a BandBook backup.');
  return j;
}

// mode: 'merge' (default) or 'replace'. Returns counts.
export async function restoreBackup(j, mode = 'merge') {
  validate(j);
  const n = { songs: 0, ink: 0, setlists: 0, files: 0, skipped: 0 };
  if (mode === 'replace') for (const s of ['songs', 'ink', 'setlists', 'files']) await db.clear(s);
  const newer = (a, b) => (a?.updatedAt || 0) > (b?.updatedAt || 0);
  for (const s of j.songs) {
    const cur = mode === 'merge' ? await db.get('songs', s.id) : null;
    if (cur && !newer(s, cur)) { n.skipped++; continue; }
    await db.put('songs', s); n.songs++;
  }
  for (const i of j.ink || []) {
    const cur = mode === 'merge' ? await db.get('ink', i.songId) : null;
    if (cur && !newer(i, cur)) continue;
    await db.put('ink', i); n.ink++;
  }
  for (const x of j.setlists || []) {
    const cur = mode === 'merge' ? await db.get('setlists', x.id) : null;
    if (cur && !newer(x, cur)) continue;
    await db.put('setlists', x); n.setlists++;
  }
  for (const f of j.files || []) {
    if (mode === 'merge' && (await db.get('files', f.id))) continue;
    await db.put('files', { id: f.id, name: f.name, mime: f.mime, blob: fromB64(f.data, f.mime) }); n.files++;
  }
  const st = j.settings || {};
  for (const k of SETTING_KEYS) {
    if (!(k in st)) continue;
    if (mode === 'merge' && k === 'folders') {
      const have = db.settings.get('folders', null) ?? db.DEFAULT_FOLDERS;
      db.settings.set('folders', [...have, ...st.folders.filter((f) => !have.includes(f))]);
    } else if (mode === 'merge' && k === 'voicings') {
      db.settings.set(k, { ...st[k], ...db.settings.get(k, {}) });
    } else db.settings.set(k, st[k]);
  }
  return n;
}
