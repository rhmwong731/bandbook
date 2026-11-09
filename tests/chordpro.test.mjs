import assert from 'node:assert/strict';
import { parseChordPro, transposeChord, transposeKey, transposeText, convertChordsOverLyrics, CHORD_RE, parseDuration, formatDuration, setDirective, toNumeral, keyRoot, chordsOf } from '../public/js/chordpro.js';

// chord regex
for (const c of ['Am7', 'F#m', 'Cmaj7', 'G/B', 'Dsus4', 'E7b9', 'Bb', 'C#dim7', 'Gadd9', 'A5', 'D/F#'])
  assert.ok(CHORD_RE.test(c), 'should match ' + c);
for (const c of ['Hello', 'the', 'Amazing', 'x'])
  assert.ok(!CHORD_RE.test(c), 'should not match ' + c);

// parsing
const p = parseChordPro('{title: Test}\n{key: G}\n{soc}\n[G]Hello [C]world\nplain line\n{eoc}\n');
assert.equal(p.meta.title, 'Test');
assert.equal(p.meta.key, 'G');
assert.deepEqual(p.lines[1].segs, [{ chord: 'G', text: 'Hello ' }, { chord: 'C', text: 'world' }]);
assert.deepEqual(p.lines[2].segs, [{ chord: '', text: 'plain line' }]);
assert.equal(p.lines[0].type, 'sectionStart');
assert.equal(p.lines[3].type, 'sectionEnd');
assert.deepEqual(parseChordPro('[Am] [G] [F]').lines[0].segs.map(s => s.chord), ['Am', 'G', 'F']);
assert.deepEqual(parseChordPro('Ama[C]zing').lines[0].segs, [{ chord: '', text: 'Ama' }, { chord: 'C', text: 'zing' }]);

// transpose
assert.equal(transposeChord('Am7', 2), 'Bm7');
assert.equal(transposeChord('G/B', 2), 'A/C#');
assert.equal(transposeChord('Dsus4', 1), 'D#sus4');
assert.equal(transposeChord('Bb', 2, true), 'C');
assert.equal(transposeChord('C', -1), 'B');
assert.equal(transposeChord('Cadd9', 12), 'Cadd9');
assert.equal(transposeKey('G', 2), 'A');
assert.equal(transposeKey('G', 3), 'Bb');
assert.equal(transposeKey('Em', 1), 'Fm');
const t = transposeText('{key: C}\n[C]a [F]b [G/B]c', 3);
assert.match(t, /\{key: Eb\}/);
assert.match(t, /\[Eb\]a \[Ab\]b \[Bb\/D\]c/);

// chords over lyrics
const conv = convertChordsOverLyrics('Verse 1\nG       C\nHello   world\n\nAm  F\n');
assert.match(conv, /\{comment: Verse 1\}/);
assert.match(conv, /\[G\]Hello   \[C\]world/);
assert.match(conv, /\[Am\] \[F\]/);

console.log('chordpro tests passed');

// durations
assert.equal(parseDuration('3:45'), 225);
assert.equal(parseDuration('225'), 225);
assert.equal(parseDuration('x'), 0);
assert.equal(parseDuration(''), 0);
assert.equal(formatDuration(225), '3:45');
assert.equal(formatDuration(3725), '1:02:05');
assert.equal(formatDuration(5), '0:05');
assert.equal(parseChordPro('{duration: 4:10}\n{audio: https://x/y.mp3}').meta.duration, '4:10');
assert.equal(parseChordPro('{length: 2:00}').meta.duration, '2:00');
assert.equal(parseChordPro('{audio: https://x/y.mp3}').meta.audio, 'https://x/y.mp3');

// setDirective
assert.equal(setDirective('{title: A}\nline', 'tempo', '90'), '{title: A}\n{tempo: 90}\nline');
assert.equal(setDirective('{title: A}\n{tempo: 80}\nline', 'tempo', '90'), '{title: A}\n{tempo: 90}\nline');
assert.equal(setDirective('{title: A}\n{tempo: 80}\nline', 'tempo', ''), '{title: A}\nline');
assert.equal(setDirective('line', 'key', 'G'), '{key: G}\nline');
assert.equal(setDirective('{length: 3:00}\nx', 'duration', '4:00'), '{duration: 4:00}\nx');
assert.equal(setDirective('{t: Hi}\nx', 'title', 'Yo'), '{title: Yo}\nx');

// numerals
assert.equal(toNumeral('G', 'G'), '1');
assert.equal(toNumeral('C', 'G'), '4');
assert.equal(toNumeral('D7', 'G'), '57');
assert.equal(toNumeral('Em', 'G'), '6m');
assert.equal(toNumeral('Bb', 'G'), 'b3');
assert.equal(toNumeral('F', 'G'), 'b7');
assert.equal(toNumeral('G/B', 'G'), '1/3');
assert.equal(toNumeral('Cmaj7', 'G'), '4maj7');
assert.equal(toNumeral('C#dim', 'G'), '#4dim');
assert.equal(toNumeral('G', 'G', 'roman'), 'I');
assert.equal(toNumeral('Em', 'G', 'roman'), 'vi');
assert.equal(toNumeral('D7', 'G', 'roman'), 'V7');
assert.equal(toNumeral('Am7', 'G', 'roman'), 'ii7');
assert.equal(toNumeral('F', 'G', 'roman'), 'bVII');
assert.equal(toNumeral('G/B', 'G', 'roman'), 'I/III');
assert.equal(toNumeral('F#dim', 'G', 'roman'), 'viidim');
assert.equal(toNumeral('Gsus4', 'G', 'roman'), 'Isus4');
assert.equal(toNumeral('C', ''), 'C');
assert.equal(toNumeral('Am', 'Am'), '1m');
assert.equal(toNumeral('F', 'Am'), 'b6');
assert.deepEqual(keyRoot('F#m'), { root: 6, minor: true });
assert.equal(keyRoot('nope'), null);
assert.deepEqual(chordsOf(parseChordPro('[G]a [C]b\n[G]c [D7]d')), ['G', 'C', 'D7']);
console.log('chordpro extra tests passed');

// any section name works: intro, pre-chorus, outro...
{
  const { parseChordPro } = await import('../public/js/chordpro.js');
  const p = parseChordPro('{start_of_intro: Intro}\n[G]La\n{end_of_intro}\n{start_of_prechorus: Pre-Chorus}\n[C]Ooh\n{end_of_prechorus}\n{start_of_outro}\n[D]End\n{end_of_outro}\n{start_of_chorus}\n[G]Sing\n{end_of_chorus}');
  const starts = p.lines.filter((l) => l.type === 'sectionStart').map((l) => l.kind + ':' + l.label);
  assert.deepEqual(starts, ['intro:Intro', 'prechorus:Pre-Chorus', 'outro:', 'chorus:']);
  assert.equal(p.lines.filter((l) => l.type === 'sectionEnd').length, 4);
  console.log('custom section tests passed');
}
