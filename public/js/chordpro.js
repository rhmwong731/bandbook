// ChordPro parsing, transposing, chords-over-lyrics conversion and DOM rendering.
// Everything except renderSheet() is DOM-free so it can be unit tested in Node.

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTE_INDEX = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);

export const CHORD_RE = /^[A-G][#b]?(?:maj|Maj|MAJ|min|Min|m|M|dim|aug|sus|add|°|\+|-)?[0-9]*(?:(?:sus|add|maj|dim|aug|alt|[#b+-])[0-9]*)*(?:\([^)]*\))?(?:\/[A-G][#b]?)?$/;

const DIRECTIVE_ALIASES = {
  t: 'title', title: 'title', st: 'subtitle', subtitle: 'subtitle', artist: 'artist', composer: 'artist',
  key: 'key', capo: 'capo', tempo: 'tempo', time: 'time', duration: 'duration', length: 'duration', audio: 'audio',
  c: 'comment', comment: 'comment', ci: 'comment', cb: 'comment',
  soc: 'start_chorus', start_of_chorus: 'start_chorus', eoc: 'end', end_of_chorus: 'end',
  sov: 'start_verse', start_of_verse: 'start_verse', eov: 'end', end_of_verse: 'end',
  sob: 'start_bridge', start_of_bridge: 'start_bridge', eob: 'end', end_of_bridge: 'end',
  sot: 'start_tab', start_of_tab: 'start_tab', eot: 'end', end_of_tab: 'end',
};

const SECTION_NAMES = { prechorus: 'Pre-Chorus' };

export function parseChordPro(text) {
  const meta = {};
  const lines = [];
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const d = line.match(/^\s*\{\s*([A-Za-z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/);
    if (d) {
      const word = d[1].toLowerCase();
      let name = DIRECTIVE_ALIASES[word];
      const value = d[2] || '';
      if (!name) { // any other section: {start_of_intro} ... {end_of_intro}, prechorus, outro, solo, tag, ...
        const g = word.match(/^(start|end)_of_([a-z][a-z0-9_-]*)$/);
        if (!g) continue;
        name = g[1] === 'end' ? 'end' : 'start_' + g[2].replace(/[^a-z0-9-]/g, '-');
      }
      if (['title', 'subtitle', 'artist', 'key', 'capo', 'tempo', 'time', 'duration', 'audio'].includes(name)) meta[name] = value;
      else if (name === 'comment') lines.push({ type: 'comment', text: value });
      else if (name === 'end') lines.push({ type: 'sectionEnd' });
      else lines.push({ type: 'sectionStart', kind: name.replace('start_', ''), label: value });
    } else if (/^\s*#/.test(line)) {
      continue;
    } else if (line.trim() === '') {
      lines.push({ type: 'blank' });
    } else {
      lines.push({ type: 'lyric', segs: parseLine(line) });
    }
  }
  return { meta, lines };
}

function parseLine(line) {
  const segs = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0;
  let chord = '';
  let m;
  while ((m = re.exec(line))) {
    const text = line.slice(last, m.index);
    if (text || chord) segs.push({ chord, text });
    chord = m[1].trim();
    last = m.index + m[0].length;
  }
  const tail = line.slice(last);
  if (tail || chord) segs.push({ chord, text: tail });
  return segs;
}

// ---------- transposition ----------

export function transposeChord(chord, steps, preferFlats) {
  if (!chord || !steps) return chord;
  return chord.replace(/[A-G][#b]?/g, (note, offset) => {
    // only touch the root and a slash-bass note, never letters inside words like "sus" / "add" / "dim"
    const prev = chord[offset - 1];
    if (offset !== 0 && prev !== '/') return note;
    const idx = NOTE_INDEX[note];
    if (idx === undefined) return note;
    const next = (((idx + steps) % 12) + 12) % 12;
    const flats = preferFlats ?? note.includes('b');
    return (flats ? FLAT : SHARP)[next];
  });
}

// ---- spelling: chords and keys are spelled the way a musician would write them in the new key ----
const LETTERS = 'CDEFGAB';
const NAT = [0, 2, 4, 5, 7, 9, 11];
const MAJOR_TO = ['C', 'Db', 'D', 'Eb', 'E', 'F', null, 'G', 'Ab', 'A', 'Bb', 'B']; // null = F# or Gb (tie)
const MINOR_TO = ['C', 'C#', 'D', null, 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B']; // null = D#m or Ebm (tie)
function spellPc(pc, letterIdx) { // the note with this letter that has this pitch class, or null if it needs a double accidental
  const d = ((((pc - NAT[letterIdx]) % 12) + 12 + 6) % 12) - 6;
  if (d === 0) return LETTERS[letterIdx];
  if (d === 1) return LETTERS[letterIdx] + '#';
  if (d === -1) return LETTERS[letterIdx] + 'b';
  return null;
}
function parseKey(key) {
  const m = String(key || '').match(/^([A-G][#b]?)(.*)$/);
  if (!m || NOTE_INDEX[m[1]] === undefined) return null;
  return { tonic: m[1], rest: m[2], minor: /^m(?!aj)/.test(m[2]) };
}
// The tonic's new name. Ties (F#/Gb, D#m/Ebm) follow the original key: sharps stay sharps, flats stay flats.
function targetTonic(k, steps) {
  const pc = (((NOTE_INDEX[k.tonic] + steps) % 12) + 12) % 12;
  let name = (k.minor ? MINOR_TO : MAJOR_TO)[pc];
  if (!name) {
    const flatty = k.tonic.includes('b') || FLAT_KEYS.has(k.tonic + (k.minor ? 'm' : ''));
    name = flatty ? (k.minor ? 'Eb' : 'Gb') : (k.minor ? 'D#' : 'F#');
  }
  return { name, pc, letter: LETTERS.indexOf(name[0]) };
}

export function transposeKey(key, steps) {
  if (!key || !steps) return key;
  const k = parseKey(key);
  if (!k) return key;
  return targetTonic(k, steps).name + k.rest;
}

// Returns chord => transposed chord, spelled by scale degree relative to the key (so Eb stays a flat chord in G: Bb, not A#).
// Without a key it falls back to plain sharp/flat spelling.
export function makeTransposer(key, steps) {
  const k = steps ? parseKey(key) : null;
  if (!steps) return (c) => c;
  if (!k) return (c) => transposeChord(c, steps);
  const t = targetTonic(k, steps);
  const shift = t.letter - LETTERS.indexOf(k.tonic[0]);
  const fallbackFlats = t.name.includes('b') || FLAT_KEYS.has(t.name + (k.minor ? 'm' : ''));
  const one = (note) => {
    const idx = NOTE_INDEX[note];
    if (idx === undefined) return note;
    const pc = (((idx + steps) % 12) + 12) % 12;
    const letter = (((LETTERS.indexOf(note[0]) + shift) % 7) + 7) % 7;
    return spellPc(pc, letter) || (fallbackFlats ? FLAT : SHARP)[pc];
  };
  return (chord) => !chord ? chord : chord.replace(/[A-G][#b]?/g, (note, offset) => {
    const prev = chord[offset - 1];
    return offset !== 0 && prev !== '/' ? note : one(note); // only the root and a slash bass, never letters inside "sus", "add", "dim"
  });
}

export function prefersFlats(key, steps) {
  const k = transposeKey(key, steps);
  if (!k) return undefined;
  const m = k.match(/^([A-G][#b]?)(m?)/);
  return m ? FLAT_KEYS.has(m[1] + m[2]) || m[1].includes('b') : undefined;
}

export function transposeText(text, steps) {
  const parsed = parseChordPro(text);
  const tr = makeTransposer(parsed.meta.key, steps);
  return String(text).replace(/\[([^\]]*)\]/g, (_, c) => `[${tr(c.trim())}]`)
    .replace(/(\{\s*key\s*:\s*)([^}]*?)(\s*\})/i, (_, a, k, z) => a + transposeKey(k.trim(), steps) + z);
}


// ---------- durations, directives ----------

export function parseDuration(v) {
  const s = String(v ?? '').trim();
  if (!s) return 0;
  const m = s.match(/^(\d+):([0-5]?\d)$/);
  if (m) return +m[1] * 60 + +m[2];
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Set (or with an empty value remove) a {name: value} directive in ChordPro text. Returns new text.
export function setDirective(text, name, value) {
  const names = { duration: ['duration', 'length'], title: ['title', 't'], artist: ['artist', 'composer'], subtitle: ['subtitle', 'st'] }[name] || [name];
  const re = new RegExp('^\\s*\\{\\s*(?:' + names.join('|') + ')\\s*(?::[^}]*)?\\}\\s*$', 'i');
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const idx = lines.findIndex((l) => re.test(l));
  const v = String(value ?? '').trim();
  if (!v) {
    if (idx >= 0) lines.splice(idx, 1);
  } else if (idx >= 0) {
    lines[idx] = `{${name}: ${v}}`;
  } else {
    // keep new directives together with the other header directives at the top
    let at = 0;
    while (at < lines.length && /^\s*\{\s*(title|t|subtitle|st|artist|composer|key|capo|tempo|time|duration|length|audio)\b/i.test(lines[at])) at++;
    lines.splice(at, 0, `{${name}: ${v}}`);
  }
  return lines.join('\n');
}

// Chord fingerings picked for this song, stored as standard ChordPro lines:
//   {define: Gmaj7 base-fret 1 frets 3 x 4 4 3 2}      (6 numbers = guitar, 4 = ukulele)
// so they travel with the song text: sync, backup and export all carry them.
const DEFINE_RE = /^\s*\{\s*define\s*:\s*(\S+)\s+base-fret\s+1\s+frets\s+([^}]*?)\s*\}\s*$/i;
export function parseDefines(text) {
  const out = {}; // { chordName: [fretsArray, ...] }
  for (const l of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = l.match(DEFINE_RE);
    if (!m) continue;
    const frets = m[2].split(/\s+/).map((f) => (/^x$/i.test(f) ? -1 : /^\d{1,2}$/.test(f) ? Number(f) : NaN));
    if (frets.length < 4 || frets.some((f) => Number.isNaN(f))) continue;
    (out[m[1]] ||= []).push(frets);
  }
  return out;
}
// Set (or with null remove) the fingering of one chord for one instrument (told apart by the number of strings).
export function setDefine(text, chord, frets, strings) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const same = (l) => {
    const m = l.match(DEFINE_RE);
    return m && m[1] === chord && m[2].split(/\s+/).length === strings;
  };
  const idx = lines.findIndex(same);
  if (!frets) { if (idx >= 0) lines.splice(idx, 1); return lines.join('\n'); }
  const line = `{define: ${chord} base-fret 1 frets ${frets.map((f) => (f < 0 ? 'x' : f)).join(' ')}}`;
  if (idx >= 0) lines[idx] = line;
  else {
    let at = 0;
    while (at < lines.length && /^\s*\{\s*(title|t|subtitle|st|artist|composer|key|capo|tempo|time|duration|length|audio|define)\b/i.test(lines[at])) at++;
    lines.splice(at, 0, line);
  }
  return lines.join('\n');
}

// ---------- Nashville / Roman numerals ----------

export function keyRoot(key) {
  const m = String(key || '').trim().match(/^([A-G][#b]?)(m(?!aj)|min)?/);
  return m ? { root: NOTE_INDEX[m[1]], minor: !!m[2] } : null;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

function degree(semi) {
  // returns [accidental, degreeIndex] relative to the major scale of the key root
  const i = MAJOR_SCALE.indexOf(semi);
  if (i >= 0) return ['', i];
  const up = MAJOR_SCALE.indexOf((semi + 11) % 12); // one above a scale tone => sharp of that degree
  const dn = MAJOR_SCALE.indexOf((semi + 1) % 12);
  if (semi === 1 || semi === 3 || semi === 8 || semi === 10) return ['b', dn]; // bII bIII bVI bVII
  if (semi === 6) return ['#', 3];
  return up >= 0 ? ['#', up] : ['', 0];
}

// style: 'nashville' (1 4 5, 6m, 1/3) or 'roman' (I IV V, vi, I/iii). Returns the chord unchanged if it can't be mapped.
export function toNumeral(chord, key, style = 'nashville') {
  const k = keyRoot(key);
  if (!k || !chord) return chord;
  const m = String(chord).match(/^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/);
  if (!m || NOTE_INDEX[m[1]] === undefined) return chord;
  const part = (note, quality, isBass) => {
    const semi = (((NOTE_INDEX[note] - k.root) % 12) + 12) % 12;
    const [acc, d] = degree(semi);
    if (style === 'nashville') return acc + (d + 1) + (isBass ? '' : quality);
    const minorQ = /^(m(?!aj)|min|dim|°)/.test(quality);
    const sym = isBass || !minorQ ? ROMAN[d] : ROMAN[d].toLowerCase();
    return acc + (isBass ? ROMAN[d] : sym + quality.replace(/^(m(?!aj)|min)/, ''));
  };
  return part(m[1], m[2], false) + (m[3] ? '/' + part(m[3], '', true) : '');
}

export function chordsOf(parsed) {
  const seen = [];
  for (const ln of parsed.lines) if (ln.type === 'lyric') for (const s of ln.segs) if (s.chord && !seen.includes(s.chord)) seen.push(s.chord);
  return seen;
}

// ---------- chords-over-lyrics -> ChordPro ----------

function isChordLine(line) {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  return toks.length > 0 && toks.every((t) => CHORD_RE.test(t.replace(/^\(|\)$/g, '')));
}

export function convertChordsOverLyrics(text) {
  const src = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const line = src[i];
    if (isChordLine(line)) {
      const lyric = src[i + 1];
      const positions = [];
      const re = /\S+/g;
      let m;
      while ((m = re.exec(line))) positions.push({ col: m.index, chord: m[0] });
      if (lyric !== undefined && lyric.trim() !== '' && !isChordLine(lyric)) {
        let res = '';
        let pos = 0;
        for (const p of positions) {
          const col = Math.min(p.col, lyric.length);
          res += lyric.slice(pos, col) + `[${p.chord}]`;
          pos = col;
        }
        res += lyric.slice(pos);
        out.push(res);
        i++;
      } else {
        out.push(positions.map((p) => `[${p.chord}]`).join(' '));
      }
    } else {
      const sec = line.match(/^\s*[\[(]?(verse|chorus|bridge|intro|outro|pre-?chorus|solo|tag|interlude)\b[^\])]*[\])]?:?\s*$/i);
      out.push(sec ? `{comment: ${line.replace(/[\[\]():]/g, '').trim()}}` : line);
    }
  }
  return out.join('\n');
}

// ---------- rendering (browser only) ----------

// capoShift > 0: show the shapes to play with a capo that many frets up (chords sound as written)
export function renderSheet(container, parsed, { transpose = 0, style = 'letters', capoShift = 0 } = {}) {
  container.textContent = '';
  const tr = makeTransposer(parsed.meta.key, transpose - capoShift);
  const useNum = style !== 'letters' && !!keyRoot(parsed.meta.key);
  container.dataset.numerals = useNum ? '1' : '';
  const head = el('div', 'song-head');
  head.append(el('h1', 'song-title', parsed.meta.title || 'Untitled'));
  const sub = [parsed.meta.artist, parsed.meta.subtitle].filter(Boolean).join(' · ');
  if (sub) head.append(el('div', 'song-sub', sub));
  const facts = [];
  if (parsed.meta.key) facts.push('Key ' + transposeKey(parsed.meta.key, transpose));
  if (transpose) facts.push(`(${transpose > 0 ? '+' : ''}${transpose})`);
  if (capoShift) {
    const k = parsed.meta.key ? transposeKey(parsed.meta.key, transpose - capoShift) : '';
    const mine = parsed.meta.capo && Number(parsed.meta.capo) !== capoShift ? ` (yours; the song says ${parsed.meta.capo})` : '';
    facts.push(`Capo ${capoShift}${mine}` + (k ? ` · play shapes in ${k}` : ' · showing capo shapes'));
  } else if (parsed.meta.capo && Number(parsed.meta.capo) > 0) facts.push(`Capo ${parsed.meta.capo} in the song · you are playing without`);
  if (parsed.meta.tempo) facts.push(parsed.meta.tempo + ' bpm');
  if (parsed.meta.duration) facts.push(formatDuration(parseDuration(parsed.meta.duration)));
  if (parsed.meta.time) facts.push(parsed.meta.time);
  if (facts.length) head.append(el('div', 'song-facts', facts.join('   ')));
  container.append(head);

  let cur = container;
  for (const ln of parsed.lines) {
    if (ln.type === 'sectionStart') {
      cur = el('div', 'section ' + ln.kind);
      const label = ln.label || SECTION_NAMES[ln.kind] || ln.kind[0].toUpperCase() + ln.kind.slice(1);
      cur.append(el('div', 'sec-label', label));
      container.append(cur);
    } else if (ln.type === 'sectionEnd') {
      cur = container;
    } else if (ln.type === 'blank') {
      cur.append(el('div', 'blank'));
    } else if (ln.type === 'comment') {
      cur.append(el('div', 'comment', ln.text));
    } else if (ln.type === 'lyric') {
      const row = el('div', 'line');
      const hasChords = ln.segs.some((s) => s.chord);
      if (!hasChords) row.classList.add('plain');
      for (const s of ln.segs) {
        const seg = el('span', 'seg');
        if (hasChords) seg.append(el('span', 'ch', s.chord ? (useNum ? toNumeral(s.chord, parsed.meta.key, style) : tr(s.chord)) : '\u00a0'));
        seg.append(el('span', 'ly', s.text || (s.chord ? '\u00a0\u00a0' : '')));
        row.append(seg);
      }
      cur.append(row);
    }
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
