// Sync engine (band server).
//   Songs, PDFs, set lists, folder names: shared with the whole band. Each has a revision number on the server.
//   Annotations: private to you (the server only hands your own back to you). Last write wins.
// Local field names kept from the Drive days: song.driveId is set (to the song's own id) once a song is shared
// with the band, song.remoteModified is the server revision we last saw.
import * as db from './store.js';
import * as srv from './server.js';
import * as sets from './sets.js';
import { merge3 } from './merge.js';

const hiddenIds = () => new Set(db.settings.get('hidden', []));
const hide = (id) => db.settings.set('hidden', [...hiddenIds(), id].slice(-500));

export async function syncAll(say = () => {}) {
  if (!srv.isJoined()) throw new Error('Join your band first (Settings).');
  const stats = { pulled: 0, pushed: 0, conflicts: 0, merged: 0, ink: 0, sets: 0 };
  let retry = false; // something could not be fetched yet: do not move the cursor past it

  say('Checking for changes…');
  const since = db.settings.get('syncSeq', 0);
  const d = await srv.pull(since);
  const hidden = hiddenIds();
  let songs = await db.all('songs');
  if (d.songs.some((r) => !r.deleted)) { // the unedited sample song makes way for the band's real library
    for (const s of songs) {
      const ink = await db.get('ink', s.id);
      if (s.demo && !s.driveId && !s.dirty && !(ink && ink.strokes && ink.strokes.length)) { await db.del('songs', s.id); await db.del('ink', s.id); }
    }
    songs = await db.all('songs');
  }
  for (const s of songs) { // remember what we last had in common with the server, to merge later edits
    if (s.driveId && !s.dirty && !db.isDoc(s) && s.baseText !== s.text) { s.baseText = s.text; await db.put('songs', s); }
  }
  const byId = new Map(songs.map((s) => [s.id, s]));

  for (const r of d.songs) {
    if (hidden.has(r.id)) continue;
    const s = byId.get(r.id);
    if (r.deleted) {
      if (s && s.driveId) { s.driveId = null; s.remoteModified = null; s.dirty = false; s.folderDirty = false; await db.put('songs', s); }
      continue;
    }
    if (s && s.remoteModified === r.rev) continue;
    if (r.kind !== 'cho') { // PDF / image: whole file replaced when it changes
      say(`Downloading ${r.title}…`);
      let blob;
      try { blob = await srv.getFile(r.id); } catch (e) { if (e.status === 404) { retry = true; continue; } throw e; }
      const doc = s || db.makeDocSong({ id: r.id, blob, kind: r.kind, mime: r.mime, fileName: r.file_name || r.title, driveId: r.id, folder: r.folder });
      doc.title = r.title; doc.kind = r.kind; doc.mime = r.mime || doc.mime; doc.fileName = r.file_name || doc.fileName;
      doc.driveId = r.id; doc.remoteModified = r.rev; doc.updatedAt = Date.now();
      if (!doc.folderDirty) doc.folder = r.folder;
      await db.put('files', { id: doc.id, blob, mime: doc.mime, name: doc.fileName });
      await db.put('songs', doc);
      stats.pulled++;
      continue;
    }
    say(`Downloading ${r.title}…`);
    if (!s) {
      const n = db.makeSong({ id: r.id, text: r.text, driveId: r.id, remoteModified: r.rev, fileName: r.title, folder: r.folder });
      n.baseText = r.text;
      await db.put('songs', n);
      stats.pulled++;
      continue;
    }
    if (s.dirty && s.text !== r.text) {
      // edited here and changed elsewhere: merge if the edits touch different lines, else keep yours as a copy
      const merged = typeof s.baseText === 'string' ? merge3(s.baseText, s.text, r.text) : null;
      if (merged !== null) {
        s.text = merged;
        s.dirty = merged !== r.text;
        s.baseText = r.text;
        s.driveId = r.id;
        s.remoteModified = r.rev;
        if (!s.folderDirty) s.folder = r.folder;
        db.refreshMeta(s);
        await db.put('songs', s);
        stats.merged++;
        continue;
      }
      // same lines changed on both sides: park the band's version and ask which to keep (nothing is lost, nothing uploads until you choose)
      s.conflict = { theirs: r.text, title: r.title, rev: r.rev, by: r.updated_by || '', at: Date.now() };
      s.driveId = r.id;
      await db.put('songs', s);
      stats.conflicts++;
      continue;
    }
    s.text = r.text;
    s.baseText = r.text;
    s.dirty = false;
    s.driveId = r.id;
    s.remoteModified = r.rev;
    if (!s.folderDirty) s.folder = r.folder;
    db.refreshMeta(s);
    await db.put('songs', s);
    stats.pulled++;
  }

  // push local edits and folder moves of shared songs
  songs = await db.all('songs');
  for (const s of songs) {
    if (!s.driveId || s.conflict || !(s.dirty || s.folderDirty)) continue;
    say(`Uploading ${s.title}…`);
    try {
      const r = await srv.putSong(s.id, { baseRev: s.remoteModified || 0, kind: db.isDoc(s) ? s.kind : 'cho', title: s.title, text: db.isDoc(s) ? '' : s.text, folder: s.folder || '', mime: s.mime, file_name: s.fileName });
      s.remoteModified = r.rev; s.dirty = false; s.folderDirty = false;
      if (!db.isDoc(s)) s.baseText = s.text;
      await db.put('songs', s);
      stats.pushed++;
    } catch (e) {
      if (e.status !== 409) throw e;
      stats.conflicts++; // someone changed it while we were syncing: the next sync pulls their version and keeps yours as a copy
    }
  }

  // set lists
  say('Syncing set lists…');
  let localSets = await db.all('setlists');
  const setById = new Map(localSets.map((x) => [x.id, x]));
  for (const r of d.setlists) {
    const cur = setById.get(r.id);
    if (r.deleted) {
      if (cur && cur.driveId) { cur.driveId = null; cur.remoteModified = null; cur.dirty = false; await db.put('setlists', cur); }
      continue;
    }
    if (cur && cur.remoteModified === r.rev) continue;
    let j;
    try { j = sets.parseSetlist(r.json); } catch { continue; }
    if (cur && cur.dirty) {
      await db.put('setlists', { ...cur, id: db.newId(), name: cur.name + ' (my edits)', driveId: null, remoteModified: null, dirty: false });
      stats.conflicts++;
    }
    await db.put('setlists', { ...(cur || {}), id: r.id, name: r.name || j.name, items: j.items, gap: j.gap, driveId: r.id, remoteModified: r.rev, dirty: false, updatedAt: j.updatedAt || Date.now() });
    stats.sets++;
  }
  localSets = await db.all('setlists');
  const songsNow = await db.all('songs');
  for (const x of localSets) {
    if (!x.driveId || !x.dirty) continue;
    sets.refreshItems(x, songsNow);
    try {
      const r = await srv.putSet(x.id, { baseRev: x.remoteModified || 0, name: x.name, json: sets.serializeSetlist(x) });
      x.dirty = false; x.remoteModified = r.rev;
      await db.put('setlists', x);
      stats.sets++;
    } catch (e) { if (e.status !== 409) throw e; stats.conflicts++; }
  }

  // personal annotations (private)
  say('Syncing your annotations…');
  for (const r of d.ink) {
    let j;
    try { j = JSON.parse(r.json); } catch { continue; }
    const rec = await db.get('ink', r.song_id);
    if (rec && (rec.dirty || (rec.updatedAt || 0) >= (j.updatedAt || 0))) continue;
    await db.put('ink', { songId: r.song_id, strokes: j.strokes || [], transpose: j.transpose || 0, tempo: j.tempo || 0, updatedAt: j.updatedAt || 0, dirty: false });
    stats.ink++;
  }
  for (const s of await db.all('songs')) {
    if (!s.driveId) continue;
    const rec = await db.get('ink', s.id);
    if (!rec?.dirty) continue;
    await srv.putInk(s.id, JSON.stringify({ v: 1, strokes: rec.strokes, transpose: rec.transpose || 0, tempo: rec.tempo || 0, updatedAt: rec.updatedAt }));
    rec.dirty = false;
    await db.put('ink', rec);
    stats.ink++;
  }

  // folder names the band uses
  const merged = (await srv.putFolders(db.getFolders(await db.all('songs')))).folders;
  db.saveFolders([...new Set([...db.getFolders(await db.all('songs')), ...merged, ...(d.folders || [])])]);

  if (!retry) db.settings.set('syncSeq', d.seq);
  db.settings.set('lastSync', Date.now());
  return stats;
}

// Share a local-only song (and PDF/image) with the band.
export async function shareSong(song) {
  if (!srv.isJoined()) throw new Error('Join your band first (Settings).');
  const doc = db.isDoc(song);
  const file = doc ? await db.get('files', song.id) : null;
  if (doc && !file) throw new Error('The file for this song is missing on this device.');
  const body = { baseRev: 0, kind: doc ? song.kind : 'cho', title: song.title, text: doc ? '' : song.text, folder: song.folder || '', mime: song.mime, file_name: song.fileName };
  let r;
  try { r = await srv.putSong(song.id, body); }
  catch (e) {
    if (e.status !== 409) throw e;
    r = await srv.putSong(song.id, { ...body, baseRev: e.data.current.rev }); // sharing again after leaving it: replace
  }
  if (doc) r = await srv.putFile(song.id, file.blob);
  if (!doc) song.baseText = song.text;
  song.driveId = song.id; song.remoteModified = r.rev; song.dirty = false; song.folderDirty = false; song.demo = false;
  await db.put('songs', song);
  const ink = await db.get('ink', song.id);
  if (ink) { ink.dirty = true; await db.put('ink', ink); }
  return song;
}

// Share a local set list. Returns how many of its songs are not shared with the band yet.
export async function shareSetlist(set) {
  if (!srv.isJoined()) throw new Error('Join your band first (Settings).');
  sets.refreshItems(set, await db.all('songs'));
  const body = { baseRev: 0, name: set.name, json: sets.serializeSetlist(set) };
  let r;
  try { r = await srv.putSet(set.id, body); }
  catch (e) { if (e.status !== 409) throw e; r = await srv.putSet(set.id, { ...body, baseRev: e.data.current.rev }); }
  set.driveId = set.id; set.remoteModified = r.rev; set.dirty = false;
  await db.put('setlists', set);
  return set.items.filter((i) => !i.driveId).length;
}

// Delete for the whole band (the caller removes the local copy).
export const removeSongEverywhere = (song) => srv.delSong(song.id);
export const removeSetEverywhere = (set) => srv.delSet(set.id);
// Remove only from this device and do not bring it back on later syncs.
export const keepOffDevice = (id) => hide(id);


// Settle a parked conflict. choice: 'mine' | 'theirs' | 'both'. Returns the song (and the copy for 'both').
export async function resolveConflict(song, choice) {
  const c = song.conflict;
  if (!c) return { song };
  const mine = song.text;
  let copy = null;
  if (choice === 'both') {
    copy = db.makeSong({ text: mine, folder: song.folder });
    copy.title = song.title + ' (my edits)';
    await db.put('songs', copy);
  }
  song.baseText = c.theirs;
  song.remoteModified = c.rev;
  if (choice === 'mine') { song.text = mine; song.dirty = mine !== c.theirs; }
  else { song.text = c.theirs; song.dirty = false; }
  delete song.conflict;
  db.refreshMeta(song);
  song.updatedAt = Date.now();
  await db.put('songs', song);
  return { song, copy };
}
