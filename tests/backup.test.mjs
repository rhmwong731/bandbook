import assert from 'node:assert/strict';
import * as db from '../js/store.js';
import { buildBackup, restoreBackup, validate } from '../js/backup.js';

// (node has no IndexedDB: the store falls back to its in-memory maps, which is what we test through)
const song = db.makeSong({ text: '{title: One}\n[G]hi', folder: 'Originals' });
const doc = db.makeDocSong({ kind: 'pdf', fileName: 'Chart.pdf', mime: 'application/pdf' });
await db.put('songs', song);
await db.put('songs', doc);
await db.put('files', { id: doc.id, name: 'Chart.pdf', mime: 'application/pdf', blob: new Blob([new Uint8Array([37, 80, 68, 70, 0, 255, 128])], { type: 'application/pdf' }) });
await db.put('ink', { songId: song.id, strokes: [{ t: 'pen' }], transpose: 2, tempo: 90, updatedAt: 10, dirty: true });
await db.put('setlists', { id: 's1', name: 'Gig', items: [{ id: song.id, title: 'One' }], gap: 20, updatedAt: 5 });

const b = await buildBackup();
validate(b);
assert.equal(b.songs.length, 2);
assert.equal(b.files.length, 1);
assert.equal(JSON.parse(JSON.stringify(b)).files[0].mime, 'application/pdf');

// replace wipes then restores, binary survives round trip
const wire = JSON.parse(JSON.stringify(b));
await db.del('songs', song.id);
await db.put('songs', db.makeSong({ text: '{title: Stray}' }));
const n = await restoreBackup(wire, 'replace');
assert.equal(n.songs, 2);
const titles = (await db.all('songs')).map((s) => s.title).sort();
assert.deepEqual(titles, ['Chart', 'One']);
const f = await db.get('files', doc.id);
assert.deepEqual([...new Uint8Array(await f.blob.arrayBuffer())], [37, 80, 68, 70, 0, 255, 128]);
assert.equal((await db.get('ink', song.id)).tempo, 90);
assert.equal((await db.get('setlists', 's1')).gap, 20);

// merge keeps newer local edits and adds missing things
const local = await db.get('songs', song.id);
local.text = '{title: One}\nLOCAL'; local.updatedAt = Date.now() + 1000;
await db.put('songs', local);
const m = await restoreBackup(wire, 'merge');
assert.equal((await db.get('songs', song.id)).text.includes('LOCAL'), true);
assert.equal(m.skipped >= 1, true);

// junk is rejected
assert.throws(() => validate({ app: 'other' }), /not a BandBook/);
assert.throws(() => validate(null));
console.log('backup tests passed');
