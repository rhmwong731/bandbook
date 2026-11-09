import assert from 'node:assert/strict';
import { merge3 } from '../public/js/merge.js';
const base = '{title: Old}\n{key: G}\n\n[G]Line one\n[C]Line two\n[D]Line three';
// different lines: both survive
assert.equal(merge3(base, base.replace('Old', 'New'), base.replace('Line three', 'Line 3')), '{title: New}\n{key: G}\n\n[G]Line one\n[C]Line two\n[D]Line 3');
// insertion (a define line) and an edit far away
const withDef = base.replace('{key: G}', '{key: G}\n{define: G base-fret 1 frets 3 2 0 0 0 3}');
assert.equal(merge3(base, withDef, base.replace('Old', 'New')), '{title: New}\n{key: G}\n{define: G base-fret 1 frets 3 2 0 0 0 3}\n\n[G]Line one\n[C]Line two\n[D]Line three');
// same change on both sides is fine
assert.equal(merge3(base, base.replace('Old', 'X'), base.replace('Old', 'X')), base.replace('Old', 'X'));
// only one side changed
assert.equal(merge3(base, base, base.replace('Old', 'N')), base.replace('Old', 'N'));
// same line changed differently: no automatic merge
assert.equal(merge3(base, base.replace('Old', 'A'), base.replace('Old', 'B')), null);
// neighbouring lines edited on each side merge fine
assert.equal(merge3(base, base.replace('Old', 'A'), base.replace('{key: G}', '{key: A}')), '{title: A}\n{key: A}\n\n[G]Line one\n[C]Line two\n[D]Line three');
// an insertion right next to a changed line is not guessed
assert.equal(merge3(base, base.replace('{key: G}', '{key: G}\n{x: 1}'), base.replace('{key: G}', '{key: A}')), null);
// trailing lines added on both ends
assert.equal(merge3('a\nb\nc', 'x\na\nb\nc', 'a\nb\nc\ny'), 'x\na\nb\nc\ny');
console.log('merge tests passed');
