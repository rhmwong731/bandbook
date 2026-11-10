import assert from 'node:assert/strict';
import { makeTransposer, transposeKey } from '../public/js/chordpro.js';

const t = (key, steps, chords) => chords.map(makeTransposer(key, steps));
// song in A, capo 3 -> play in F#: sharps, not Gb/Db
assert.deepEqual(t('A', -3, ['A', 'D', 'E', 'F#m']), ['F#', 'B', 'C#', 'D#m']);
// C major with borrowed Eb, up to G: Bb not A#
assert.deepEqual(t('C', 7, ['C', 'Eb', 'F', 'G']), ['G', 'Bb', 'C', 'D']);
// up to Eb: flats
assert.deepEqual(t('C', 3, ['C', 'Am', 'F', 'G']), ['Eb', 'Cm', 'Ab', 'Bb']);
// slash bass and suffixes keep working
assert.deepEqual(t('G', 2, ['G/B', 'Dsus4', 'Cadd9']), ['A/C#', 'Esus4', 'Dadd9']);
// keys
assert.equal(transposeKey('C', 3), 'Eb');
assert.equal(transposeKey('A', 1), 'Bb');
assert.equal(transposeKey('Em', -1), 'D#m');
assert.equal(transposeKey('C', 0), 'C');
// no key: plain fallback
assert.equal(makeTransposer('', 1)('C'), 'C#');
console.log('key spelling tests passed');
