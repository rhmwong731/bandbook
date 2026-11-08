// Sync engine.
//  Songs:       shared band folder (Drive)  <->  local IndexedDB.   Conflicts keep both versions.
//  Annotations: private appDataFolder (Drive)  <->  local ink.      Last write wins (it's your own data).
import * as db from './store.js';
import * as drive from './drive.js';
import * as sets from './sets.js';

const safeName = (t) => (t || 'Untitled').replace(/[\\/:*?"<>|]/g, '-').trim() + '.cho';
const inkName = (song) => `ink-${song.driveId || song.id}.json`;

export async function syncAll(say = () => {}) {
  const folderId = db.settings.get('folderId', '');
  if (!folderId) throw new Error('Set the band folder in Settings first.');
  const stats = { pulled: 0, pushed: 0, conflicts: 0, ink: 0, sets: 0 };

  say('Reading band folder…');
  // the band folder itself = Unfiled; each sub-folder = a song folder (Originals, Medleys, Covers...)
  const places = [{ id: folderId, name: '' }, ...(await drive.listSubfolders(folderId)).map((f) => ({ id: f.id, name: f.name }))];
  const remote = [];
  for (const pl of places) {
    for (const f of await drive.listFolder(pl.id)) remote.push({ ...f, folder: pl.name, parent: pl.id });
  }
  const remoteIds = new Set(remote.map((f) => f.id));
  let songs = await db.all('songs');
  const byDrive = new Map(songs.filter((s) => s.driveId).map((s) => [s.driveId, s]));

  for (const f of remote) {
    const s = byDrive.get(f.id);
    if (s && !s.folderDirty && ((s.folder || '') !== f.folder || s.driveParent !== f.parent)) {
      s.folder = f.folder; s.driveParent = f.parent; // someone moved it on Drive
      await db.put('songs', s);
    }
    if (s && s.remoteModified === f.modifiedTime) continue;
    say(`Downloading ${f.name}…`);
    const kind = db.kindOfFile(f.name, f.mimeType);
    if (kind) { // PDF / image: binary, replaced wholesale (these are read-only for the band)
      const blob = await drive.downloadBlob(f.id);
      const doc = s || db.makeDocSong({ blob, kind, mime: f.mimeType, fileName: f.name, driveId: f.id, folder: f.folder, driveParent: f.parent });
      doc.remoteModified = f.modifiedTime;
      await db.put('files', { id: doc.id, blob, mime: doc.mime, name: f.name });
      await db.put('songs', doc);
      stats.pulled++;
      continue;
    }
    const text = await drive.downloadText(f.id);
    if (!s) {
      await db.put('songs', db.makeSong({ text, driveId: f.id, remoteModified: f.modifiedTime, fileName: f.name, folder: f.folder, driveParent: f.parent }));
      stats.pulled++;
      continue;
    }
    if (s.dirty && s.text !== text) {
      // you edited locally AND someone changed it on Drive: keep your version as a personal copy
      const copy = db.makeSong({ text: s.text, folder: s.folder });
      copy.title = s.title + ' (my edits)';
      await db.put('songs', copy);
      const ink = await db.get('ink', s.id);
      if (ink) await db.put('ink', { ...ink, songId: copy.id, dirty: true, remoteModified: null });
      stats.conflicts++;
    }
    s.text = text;
    s.dirty = false;
    s.remoteModified = f.modifiedTime;
    db.refreshMeta(s);
    await db.put('songs', s);
    stats.pulled++;
  }

  // songs whose Drive file disappeared become local-only copies
  songs = await db.all('songs');
  for (const s of songs) {
    if (s.driveId && !remoteIds.has(s.driveId)) { s.driveId = null; s.remoteModified = null; await db.put('songs', s); }
  }

  // push local edits of shared songs
  for (const s of songs) {
    if (s.driveId && s.dirty && !db.isDoc(s)) {
      say(`Uploading ${s.title}…`);
      const r = await drive.updateText(s.driveId, s.text);
      s.dirty = false; s.remoteModified = r.modifiedTime;
      await db.put('songs', s);
      stats.pushed++;
    }
  }

  // push folder moves made on this device
  for (const s of songs) {
    if (s.driveId && s.folderDirty) {
      say(`Moving ${s.title}…`);
      const target = s.folder ? await drive.findOrCreateFolder(s.folder, folderId) : folderId;
      const from = s.driveParent || folderId;
      if (target !== from) { const r = await drive.moveFile(s.driveId, target, from); s.remoteModified = r.modifiedTime || s.remoteModified; }
      s.driveParent = target; s.folderDirty = false;
      await db.put('songs', s);
      stats.pushed++;
    }
  }

  // remember folder names the band uses (only ones that actually hold songs)
  const known = db.getFolders(await db.all('songs'));
  const merged = [...known];
  for (const f of remote) if (f.folder && !merged.includes(f.folder)) merged.push(f.folder);
  db.saveFolders(merged);

  // set lists (small JSON files in the band folder)
  say('Syncing set lists…');
  const remoteSets = await drive.listSetlists(folderId);
  const rSetIds = new Set(remoteSets.map((f) => f.id));
  let localSets = await db.all('setlists');
  const bySetDrive = new Map(localSets.filter((x) => x.driveId).map((x) => [x.driveId, x]));
  for (const f of remoteSets) {
    const cur = bySetDrive.get(f.id);
    if (cur && cur.remoteModified === f.modifiedTime) continue;
    const j = sets.parseSetlist(await drive.downloadText(f.id));
    if (cur && cur.dirty) {
      await db.put('setlists', { ...cur, id: db.newId(), name: cur.name + ' (my edits)', driveId: null, remoteModified: null, dirty: false });
      stats.conflicts++;
    }
    await db.put('setlists', { ...(cur || { id: db.newId() }), name: j.name, items: j.items, driveId: f.id, remoteModified: f.modifiedTime, dirty: false, updatedAt: j.updatedAt || Date.now() });
    stats.sets++;
  }
  localSets = await db.all('setlists');
  const songsNow = await db.all('songs');
  for (const x of localSets) {
    if (x.driveId && !rSetIds.has(x.driveId)) { x.driveId = null; x.remoteModified = null; await db.put('setlists', x); }
    else if (x.driveId && x.dirty) {
      sets.refreshItems(x, songsNow);
      const r = await drive.updateText(x.driveId, sets.serializeSetlist(x), 'application/json');
      x.dirty = false; x.remoteModified = r.modifiedTime;
      await db.put('setlists', x);
      stats.sets++;
    }
  }

  // personal annotations
  say('Syncing your annotations…');
  const remoteInk = new Map((await drive.listAppData()).map((f) => [f.name, f]));
  songs = await db.all('songs');
  for (const s of songs) {
    const rec = await db.get('ink', s.id);
    const rf = remoteInk.get(inkName(s));
    if (rec?.dirty) {
      const body = JSON.stringify({ v: 1, strokes: rec.strokes, transpose: rec.transpose || 0, tempo: rec.tempo || 0, updatedAt: rec.updatedAt });
      const r = rf ? await drive.updateText(rf.id, body, 'application/json') : await drive.createText(inkName(s), body, 'appDataFolder', 'application/json');
      rec.dirty = false; rec.remoteModified = r.modifiedTime;
      await db.put('ink', rec);
      stats.ink++;
    } else if (rf && (!rec || rec.remoteModified !== rf.modifiedTime)) {
      const j = JSON.parse(await drive.downloadText(rf.id));
      await db.put('ink', { songId: s.id, strokes: j.strokes || [], transpose: j.transpose || 0, tempo: j.tempo || 0, updatedAt: j.updatedAt || 0, dirty: false, remoteModified: rf.modifiedTime });
      stats.ink++;
    }
  }
  db.settings.set('lastSync', Date.now());
  return stats;
}

// Upload a local-only song to the shared band folder.
export async function shareSong(song) {
  const folderId = db.settings.get('folderId', '');
  if (!folderId) throw new Error('Set the band folder in Settings first.');
  const parent = song.folder ? await drive.findOrCreateFolder(song.folder, folderId) : folderId;
  let r;
  if (db.isDoc(song)) {
    const f = await db.get('files', song.id);
    if (!f) throw new Error('The file for this song is missing on this device.');
    r = await drive.createBlob(song.fileName || song.title + (song.kind === 'pdf' ? '.pdf' : '.png'), f.blob, parent);
  } else {
    r = await drive.createText(safeName(song.title), song.text, parent);
  }
  song.driveId = r.id; song.remoteModified = r.modifiedTime; song.dirty = false;
  song.driveParent = parent; song.folderDirty = false;
  await db.put('songs', song);
  const ink = await db.get('ink', song.id);
  if (ink) { ink.dirty = true; await db.put('ink', ink); } // re-key the annotation file
  return song;
}

// Upload a local set list to the band folder. Returns how many of its songs are not in the band folder yet.
export async function shareSetlist(set) {
  const folderId = db.settings.get('folderId', '');
  if (!folderId) throw new Error('Set the band folder in Settings first.');
  sets.refreshItems(set, await db.all('songs'));
  const r = await drive.createText(sets.setlistFileName(set), sets.serializeSetlist(set), folderId, 'application/json');
  set.driveId = r.id; set.remoteModified = r.modifiedTime; set.dirty = false;
  await db.put('setlists', set);
  return set.items.filter((i) => !i.driveId).length;
}
