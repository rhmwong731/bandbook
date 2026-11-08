// Local-first storage: IndexedDB for songs + personal ink, localStorage for settings.
import { parseChordPro, parseDuration } from './chordpro.js';

let dbp;
function open() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('bandbook', 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const [name, keyPath] of [['songs', 'id'], ['ink', 'songId'], ['setlists', 'id'], ['files', 'id']]) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath });
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

const mem = { songs: new Map(), ink: new Map(), setlists: new Map(), files: new Map() };
const memKey = { songs: 'id', ink: 'songId', setlists: 'id', files: 'id' };
let memMode = false;
async function run(store, mode, fn, memFn) {
  if (!memMode) {
    try { return await tx(store, mode, fn); } catch { memMode = true; }
  }
  return memFn(mem[store]);
}
export const all = (store) => run(store, 'readonly', (s) => s.getAll(), (m) => [...m.values()]);
export const get = (store, key) => run(store, 'readonly', (s) => s.get(key), (m) => m.get(key));
export const put = (store, val) => run(store, 'readwrite', (s) => s.put(val), (m) => { m.set(val[memKey[store]], val); return val; });
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key), (m) => { m.delete(key); });

export const clear = (store) => run(store, 'readwrite', (s) => s.clear(), (m) => { m.clear(); });

export const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2));

export const settings = {
  get(k, d) {
    try { const v = localStorage.getItem('bb_' + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem('bb_' + k, JSON.stringify(v)); } catch { /* private mode */ }
  },
};

// Song record: { id, text, title, artist, key, driveId, remoteModified, dirty, updatedAt }
export function makeSong({ id, text, driveId = null, remoteModified = null, fileName = '', folder = '', driveParent = null }) {
  const meta = parseChordPro(text).meta;
  return {
    id: id || newId(),
    text,
    title: meta.title || fileName.replace(/\.[^.]+$/, '') || 'Untitled',
    artist: meta.artist || '',
    key: meta.key || '',
    driveId,
    remoteModified,
    dirty: false,
    folder,            // '' = Unfiled
    driveParent,       // (unused now, kept so old data still loads)
    folderDirty: false, // moved locally, move not yet pushed to the band
    updatedAt: Date.now(),
  };
}

// PDF / image "song": the file itself lives in the 'files' store under the same id as the song.
export const DOC_KINDS = ['pdf', 'image'];
export const isDoc = (song) => !!song && DOC_KINDS.includes(song.kind);
export const kindOfFile = (name, mime = '') =>
  /pdf/i.test(mime) || /\.pdf$/i.test(name) ? 'pdf' : /^image\//i.test(mime) || /\.(png|jpe?g|webp|gif)$/i.test(name) ? 'image' : null;

export function makeDocSong({ id, blob, kind, mime, fileName, driveId = null, remoteModified = null, folder = '', driveParent = null }) {
  return {
    id: id || newId(),
    text: '',
    kind,
    mime: mime || blob?.type || (kind === 'pdf' ? 'application/pdf' : 'image/png'),
    fileName,
    info: {},
    title: fileName.replace(/\.[^.]+$/, '') || 'Untitled',
    artist: '',
    key: '',
    driveId,
    remoteModified,
    dirty: false,
    folder,
    driveParent,
    folderDirty: false,
    updatedAt: Date.now(),
  };
}

// Header facts (title/artist/key/tempo/time/duration/audio/capo) for any kind of song.
export function metaOf(song) {
  if (isDoc(song)) return { title: song.title, artist: song.artist, key: song.key, ...(song.info || {}) };
  return parseChordPro(song.text).meta;
}
export const durationOf = (song) => parseDuration(metaOf(song).duration);

export function refreshMeta(song) {
  if (isDoc(song)) return song;
  const meta = parseChordPro(song.text).meta;
  song.title = meta.title || song.title || 'Untitled';
  song.artist = meta.artist || '';
  song.key = meta.key || '';
  return song;
}

// Personal annotation record: { songId, strokes, transpose, updatedAt, dirty, remoteModified }
export async function getInk(songId) {
  return (await get('ink', songId)) || { songId, strokes: [], transpose: 0, updatedAt: 0, dirty: false, remoteModified: null };
}

// ---------- folders ----------
export const DEFAULT_FOLDERS = ['Originals', 'Medleys', 'Covers'];

// Ordered folder names: the saved list, then any folder names only songs know about (e.g. from Drive).
export function getFolders(songs = []) {
  const list = settings.get('folders', null) ?? DEFAULT_FOLDERS.slice();
  const extra = [...new Set(songs.map((s) => s.folder).filter((f) => f && !list.includes(f)))];
  return [...list, ...extra];
}
export const saveFolders = (list) => settings.set('folders', list);
