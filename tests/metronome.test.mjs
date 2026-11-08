import assert from 'node:assert/strict';
import { tapTempo, clampBpm, beatsPerBar } from '../public/js/metronome.js';
assert.equal(tapTempo([0]), 0);
assert.equal(tapTempo([0, 500]), 120);
assert.equal(tapTempo([0, 600, 1200, 1800]), 100);
assert.equal(tapTempo([0, 10000]), 30); // clamped
assert.equal(clampBpm(1000), 300);
assert.equal(clampBpm('abc'), 30);
assert.equal(beatsPerBar('6/8'), 6);
assert.equal(beatsPerBar('3/4'), 3);
assert.equal(beatsPerBar(''), 4);
console.log('metronome tests passed');
