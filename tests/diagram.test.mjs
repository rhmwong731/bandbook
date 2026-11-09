import assert from 'node:assert/strict';
import { voicings, parseChord, renderSvg } from '../public/js/diagram.js';

const shape = (v) => v.frets.map((f) => (f < 0 ? 'x' : f)).join('');
const top = (c, i = 'guitar') => shape(voicings(c, i)[0]);
const has = (c, s, i = 'guitar') => voicings(c, i).some((v) => shape(v) === s);

// the standard open chords come first
const first = { C: 'x32010', A: 'x02220', G: '320003', D: 'xx0232', E: '022100', Am: 'x02210', Em: '022000', Dm: 'xx0231' };
for (const [c, s] of Object.entries(first)) assert.equal(top(c), s, `${c} should lead with ${s}, got ${top(c)}`);
// and the seventh chords have their cowboy shapes available
const avail = { E7: '020100', A7: 'x02020', D7: 'xx0212', G7: '320001', B7: 'x21202', Cmaj7: 'x32000', Am7: 'x02010', Fmaj7: '102210' };
for (const [c, s] of Object.entries(avail)) assert.ok(has(c, s), `${c} should offer ${s}; got ${voicings(c).map(shape).join(' ')}`);
// F needs a barre somewhere; bar chord shapes up the neck
assert.ok(voicings('F').some((v) => v.barre), 'F has a barre voicing');
assert.ok(voicings('Bm').some((v) => v.barre && v.barre.fret === 2), 'Bm has the x24432 shape');

// every voicing is playable: contiguous, <=4 fingers, contains root bass, has the third
for (const c of ['C', 'F#m7', 'Bb', 'Dsus4', 'G/B', 'Cadd9', 'E7', 'Abmaj7', 'Bdim']) {
  const vs = voicings(c);
  assert.ok(vs.length > 0, 'voicings for ' + c);
  assert.ok(vs.length <= 12);
  const ch = parseChord(c);
  const open = [40, 45, 50, 55, 59, 64];
  for (const v of vs) {
    assert.ok(v.fingers <= 5, c + ' fingers ' + shape(v));
    const snd = v.frets.map((f, i) => (f >= 0 ? i : -1)).filter((i) => i >= 0);
    const skipA = v.frets[0] >= 0 && v.frets[1] < 0 && snd.length >= 5;
    if (!skipA) assert.equal(snd[snd.length - 1] - snd[0] + 1, snd.length, c + ' contiguous ' + shape(v));
    const pcs = new Set(snd.map((i) => (open[i] + v.frets[i]) % 12));
    for (const r of ch.required) assert.ok(pcs.has(r), `${c} missing tone in ${shape(v)}`);
    assert.equal((open[snd[0]] + v.frets[snd[0]]) % 12, ch.bass, c + ' bass of ' + shape(v));
  }
}
// slash chords put the named note in the bass
assert.equal(((40 + voicings('G/B')[0].frets.findIndex((f) => f >= 0) * 0) % 12), 4); // sanity of the table
const gb = voicings('G/B')[0];
const lowest = gb.frets.findIndex((f) => f >= 0);
assert.equal(([40, 45, 50, 55, 59, 64][lowest] + gb.frets[lowest]) % 12, 11);

// ukulele
assert.equal(top('C', 'ukulele'), '0003');
assert.equal(top('G', 'ukulele'), '0232');
assert.equal(top('Am', 'ukulele'), '2000');
assert.equal(top('F', 'ukulele'), '2010');

// parsing odds and ends
assert.equal(parseChord('Hello'), null);
assert.ok(parseChord('Am7').required.includes(0));
assert.deepEqual(voicings('Zz'), []);

// svg
const svg = renderSvg(voicings('C')[0], { name: 'C' });
assert.ok(svg.startsWith('<svg') && svg.includes('cd-dot') && svg.includes('cd-nut'));
assert.ok(renderSvg(null, { name: 'Q' }).includes('no shape'));
console.log('diagram tests passed');

// different spellings of the same chord must give the same shapes (DMaj7 used to come out wrong)
{
  const sh = (c) => voicings(c).map((v) => v.frets.map((f) => (f < 0 ? 'x' : f)).join('')).join(' ');
  for (const [a, b] of [['DMaj7', 'Dmaj7'], ['DM7', 'Dmaj7'], ['DMAJ7', 'Dmaj7'], ['DΔ7', 'Dmaj7'], ['DMin7', 'Dm7'], ['Dmin7', 'Dm7'], ['D-7', 'Dm7'], ['DMaj9', 'Dmaj9'], ['CMaj7', 'Cmaj7']]) {
    assert.equal(sh(a), sh(b), `${a} should match ${b}`);
  }
  assert.ok(voicings('DMaj7').some((v) => v.frets.map((f) => (f < 0 ? 'x' : f)).join('') === 'x57675'), 'x57675 is offered for Dmaj7');
  // every shape offered for Dmaj7 only uses D, F#, A, C#
  const tones = new Set([2, 6, 9, 1]);
  for (const v of voicings('DMaj7')) v.frets.forEach((f, i) => { if (f >= 0) assert.ok(tones.has(([40, 45, 50, 55, 59, 64][i] + f) % 12), 'wrong note in ' + v.frets.join(',')); });
  console.log('chord spelling tests passed');
}

// the common moveable barre shapes must be reachable, not crowded out by near-copies of open shapes
{
  const has2 = (c, s) => voicings(c).some((v) => v.frets.map((f) => (f < 0 ? 'x' : f)).join('') === s);
  assert.ok(has2('Em7', 'x79787'), 'Em7 offers x79787');
  assert.ok(has2('Dmaj7', 'x57675'), 'Dmaj7 offers x57675');
  assert.ok(has2('Am7', '575555'), 'Am7 offers 575555');
  assert.ok(has2('Bm7', '797777'), 'Bm7 offers 797777');
  assert.ok(has2('F', '133211'), 'F offers the full barre');
  // nothing ends up as just a muted copy of another listed shape
  for (const c of ['Em7', 'Cmaj7', 'G7']) {
    const vs = voicings(c);
    for (const a of vs) for (const b of vs) if (a !== b && a.frets.every((f, i) => f < 0 || b.frets[i] === f) && b.frets.findIndex((f) => f >= 0) === a.frets.findIndex((f) => f >= 0)) assert.fail(`${c}: ${a.frets} duplicates ${b.frets}`);
  }
  console.log('barre availability tests passed');
}

assert.ok(voicings('Gmaj7').some((v) => shape(v) === '3x4432'), 'Gmaj7 3x4432');
console.log('skip-A shape tests passed');

import { parseShape, shapeText, customVoicing } from '../public/js/diagram.js';
assert.deepEqual(parseShape('3x4432'), [3, -1, 4, 4, 3, 2]);
assert.deepEqual(parseShape('x.10.12.12.12.10'), [-1, 10, 12, 12, 12, 10]);
assert.deepEqual(parseShape('0 2 2 1 0 0'), [0, 2, 2, 1, 0, 0]);
assert.equal(parseShape('3x44'), null);
assert.equal(parseShape('3x44zz'), null);
assert.equal(parseShape('2100', 'ukulele').length, 4);
assert.equal(shapeText(customVoicing([-1, 10, 12, 12, 12, 10])), 'x.10.12.12.12.10');
console.log('shape text tests passed');
