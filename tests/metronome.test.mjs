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

// pause / resume / stop with a fake audio clock
{
  const { Metronome } = await import('../public/js/metronome.js');
  const fake = () => ({ connect() { return this; }, start() {}, stop() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {}, frequency: {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } });
  const ctx = { currentTime: 0, state: 'running', destination: {}, createOscillator: fake, createGain: () => ({ ...fake(), gain: fake().gain }) };
  globalThis.AudioContext = function () { return ctx; };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  const m = new Metronome();
  m.bpm = 120; m.beats = 4;
  assert.equal(m.start(), true);
  assert.equal(m.running, true);
  m.pause();
  assert.equal(m.running, false);
  assert.equal(m.paused, true);
  assert.equal(m._beat, 0, 'nothing had sounded yet, so pausing rewinds to the start');
  assert.equal(m.resume(), true);
  assert.equal(m.running, true);
  assert.equal(m.paused, false);
  assert.equal(m.start(), false, 'cannot start twice');
  m.stop();
  assert.equal(m.paused, false);
  assert.equal(m._beat, 0);
  assert.equal(m.resume(), false, 'nothing to resume after stop');
  console.log('metronome pause tests passed');
}
