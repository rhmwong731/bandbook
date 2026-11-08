import assert from 'node:assert/strict';
import { byOrder, insertAmong, moveIndex } from '../public/js/order.js';

const mk = (id, title, order) => ({ id, title, ...(order === undefined ? {} : { order }) });

// unordered songs sort alphabetically; ordered ones come first
const list = [mk('c', 'Charlie'), mk('a', 'Alpha'), mk('b', 'Bravo', 0)];
assert.deepEqual(list.sort(byOrder).map((s) => s.id), ['b', 'a', 'c']);

// insert before / after / at end
const peers = [mk('a', 'A', 0), mk('b', 'B', 1), mk('c', 'C', 2)];
const x = mk('x', 'X');
assert.deepEqual(insertAmong(peers, x, 'a', false).map((s) => s.id), ['x', 'a', 'b', 'c']);
assert.deepEqual(insertAmong(peers, x, 'b', true).map((s) => s.id), ['a', 'b', 'x', 'c']);
assert.deepEqual(insertAmong(peers, x, null).map((s) => s.id), ['a', 'b', 'c', 'x']);
// moving an existing peer does not duplicate it
assert.deepEqual(insertAmong(peers, peers[2], 'a', false).map((s) => s.id), ['c', 'a', 'b']);

// moveIndex
const items = ['a', 'b', 'c', 'd'];
assert.deepEqual(moveIndex(items, 0, 2, true), ['b', 'c', 'a', 'd']);
assert.deepEqual(moveIndex(items, 0, 2, false), ['b', 'a', 'c', 'd']);
assert.deepEqual(moveIndex(items, 3, 0, false), ['d', 'a', 'b', 'c']);
assert.deepEqual(moveIndex(items, 3, 0, true), ['a', 'd', 'b', 'c']);
assert.deepEqual(moveIndex(items, 1, 1, true), items);
assert.deepEqual(moveIndex(items, 1, 0, true), items); // dropping right after the row above = no change

console.log('order tests passed');
