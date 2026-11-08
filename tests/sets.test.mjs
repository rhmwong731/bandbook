import assert from 'node:assert/strict';
import { itemFor, resolve, resolveAll, refreshItems, move, serializeSetlist, parseSetlist, setlistFileName } from '../public/js/sets.js';

const songs = [
  { id: 'a1', driveId: 'D1', title: 'Amazing Grace' },
  { id: 'b2', driveId: null, title: 'Local Tune' },
  { id: 'c3', driveId: 'D3', title: 'Third' },
];

// resolve: drive id wins even when the local id differs (another device's item)
assert.equal(resolve({ id: 'zzz', driveId: 'D3', title: 'x' }, songs).id, 'c3');
assert.equal(resolve({ id: 'b2', driveId: null, title: 'x' }, songs).id, 'b2');
assert.equal(resolve({ id: null, driveId: null, title: 'local tune' }, songs).id, 'b2');
assert.equal(resolve({ id: 'nope', driveId: null, title: 'Missing' }, songs), null);

// reorder
const items = ['x', 'y', 'z'];
assert.deepEqual(move(items, 0, 1), ['y', 'x', 'z']);
assert.deepEqual(move(items, 2, -1), ['x', 'z', 'y']);
assert.deepEqual(move(items, 0, -1), items);
assert.deepEqual(move(items, 2, 1), items);

// refresh picks up a Drive id that appeared after sharing
const set = { name: 'Sat', items: [{ id: 'b2', driveId: null, title: 'Old Title' }] };
songs[1].driveId = 'D2'; songs[1].title = 'Local Tune';
refreshItems(set, songs);
assert.deepEqual(set.items[0], { id: 'b2', driveId: 'D2', title: 'Local Tune' });

// round trip
const text = serializeSetlist({ name: 'Sat Night', items: [itemFor(songs[0]), itemFor(songs[2])], updatedAt: 5 });
const back = parseSetlist(text);
assert.equal(back.name, 'Sat Night');
assert.deepEqual(back.items.map((i) => i.driveId), ['D1', 'D3']);
assert.equal(resolveAll(back, songs)[1].song.id, 'c3');
assert.equal(setlistFileName({ name: 'Sat/Sun: Gig' }), 'Sat-Sun- Gig.setlist.json');

console.log('sets tests passed');

import { setStats as _ss, serializeSetlist as _ser, parseSetlist as _par } from '../public/js/sets.js';
{
  const songs = [{ id: 'a', title: 'A', dur: 200 }, { id: 'b', title: 'B', dur: 0 }, { id: 'c', title: 'C', dur: 100 }];
  const set = { name: 'S', gap: 30, items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }, { id: 'zz', title: 'Gone' }] };
  const st = _ss(set, songs, (s) => s.dur);
  assert.equal(st.count, 3);
  assert.equal(st.untimed, 1);
  assert.equal(st.songsTotal, 300);
  assert.equal(st.gaps, 60);
  assert.equal(st.total, 360);
  assert.deepEqual(st.durations, [200, 0, 100, 0]);
  assert.equal(_par(_ser(set)).gap, 30);
  assert.equal(_par(JSON.stringify({ name: 'x', items: [] })).gap, 0);
}
console.log('sets stats tests passed');
