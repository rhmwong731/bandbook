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
    assert.ok(v.fingers <= 4, c + ' fingers ' + shape(v));
    const snd = v.frets.map((f, i) => (f >= 0 ? i : -1)).filter((i) => i >= 0);
    assert.equal(snd[snd.length - 1] - snd[0] + 1, snd.length, c + ' contiguous ' + shape(v));
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
