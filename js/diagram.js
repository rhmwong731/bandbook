// Chord diagrams: an algorithmic voicing generator (guitar / ukulele) and an SVG renderer.
// No DOM needed to generate voicings, so everything except renderSvg's use in the page is unit tested.
// Voicing = { frets: [-1|0|n per string, low string first], base, barre: {fret, from, to}|null, fingers, cost }

export const TUNINGS = {
  guitar: { name: 'Guitar', strings: [40, 45, 50, 55, 59, 64], names: 'EADGBE', minSound: 4, lowBass: true },
  ukulele: { name: 'Ukulele', strings: [67, 60, 64, 69], names: 'GCEA', minSound: 4, lowBass: false },
};

const NOTE_INDEX = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

// quality -> semitone set from the root
const QUALITIES = [
  ['maj13', [0, 4, 7, 11, 2, 9]], ['m13', [0, 3, 7, 10, 2, 9]], ['13', [0, 4, 7, 10, 2, 9]],
  ['maj11', [0, 4, 7, 11, 2, 5]], ['m11', [0, 3, 7, 10, 2, 5]], ['11', [0, 4, 7, 10, 2, 5]],
  ['maj9', [0, 4, 7, 11, 2]], ['m9', [0, 3, 7, 10, 2]], ['9', [0, 4, 7, 10, 2]],
  ['m7b5', [0, 3, 6, 10]], ['dim7', [0, 3, 6, 9]], ['dim', [0, 3, 6]], ['aug7', [0, 4, 8, 10]], ['aug', [0, 4, 8]],
  ['maj7', [0, 4, 7, 11]], ['m7', [0, 3, 7, 10]], ['mmaj7', [0, 3, 7, 11]], ['7sus4', [0, 5, 7, 10]], ['7sus2', [0, 2, 7, 10]],
  ['7', [0, 4, 7, 10]], ['m6', [0, 3, 7, 9]], ['6', [0, 4, 7, 9]], ['6/9', [0, 4, 7, 9, 2]], ['69', [0, 4, 7, 9, 2]],
  ['madd9', [0, 3, 7, 2]], ['add9', [0, 4, 7, 2]], ['sus4', [0, 5, 7]], ['sus2', [0, 2, 7]], ['sus', [0, 5, 7]],
  ['m', [0, 3, 7]], ['5', [0, 7]], ['', [0, 4, 7]],
];

const ALIASES = [[/^M7$/, 'maj7'], [/^(min|-)/, 'm'], [/^\+/, 'aug'], [/^°7$/, 'dim7'], [/^°/, 'dim'], [/^M/, 'maj'], [/^ø/, 'm7b5']];

export function parseChord(name) {
  const m = String(name || '').trim().match(/^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/);
  if (!m || NOTE_INDEX[m[1]] === undefined) return null;
  let q = m[2].replace(/\(([^)]*)\)/g, '$1');
  for (const [re, to] of ALIASES) if (re.test(q)) { q = q.replace(re, to); break; }
  let tones = null;
  for (const [key, set] of QUALITIES) if (q === key) { tones = set; break; }
  if (!tones) { // unknown extension: fall back to the longest known prefix
    for (const [key, set] of QUALITIES) if (key && q.startsWith(key)) { tones = set; break; }
    if (!tones) tones = /^m(?!aj)/.test(q) ? [0, 3, 7] : [0, 4, 7];
  }
  const root = NOTE_INDEX[m[1]];
  const bass = m[3] ? NOTE_INDEX[m[3]] : root;
  const pcs = [...new Set(tones.map((t) => (root + t) % 12))];
  // the fifth may be left out of bigger chords (it is the least important tone)
  const fifth = (root + 7) % 12;
  const optional = tones.length > 3 && tones.includes(7) ? [fifth] : [];
  const required = pcs.filter((p) => !optional.includes(p));
  if (!required.includes(bass)) required.push(bass);
  return { name, root, bass, slash: !!m[3], pcs: new Set([...pcs, bass]), required, optional };
}

function analyse(frets, tuning) {
  const n = frets.length;
  const sounding = frets.map((f, i) => (f >= 0 ? i : -1)).filter((i) => i >= 0);
  const fretted = frets.map((f, i) => (f > 0 ? i : -1)).filter((i) => i >= 0);
  const minF = fretted.length ? Math.min(...fretted.map((i) => frets[i])) : 0;
  let barre = null;
  if (fretted.length) {
    const at = fretted.filter((i) => frets[i] === minF);
    if (at.length >= 2 && at[at.length - 1] - at[0] >= 3) {
      const from = at[0];
      const to = at[at.length - 1];
      // a barre needs every string it covers to be pressed at that fret or above (no open/muted ones under it)
      let ok = true;
      for (let i = from; i <= to; i++) if (frets[i] < minF) ok = false;
      if (ok) barre = { fret: minF, from, to };
    }
  }
  let fingers = fretted.length;
  if (barre) fingers -= fretted.filter((i) => frets[i] === barre.fret && i >= barre.from && i <= barre.to).length - 1;
  return { n, sounding, fretted, minF, barre, fingers };
}

const cache = new Map();

export function voicings(chordName, instrument = 'guitar', limit = 12) {
  const key = instrument + ':' + chordName + ':' + limit;
  if (cache.has(key)) return cache.get(key);
  const tuning = TUNINGS[instrument] || TUNINGS.guitar;
  const ch = parseChord(chordName);
  const out = [];
  if (ch) {
    const seen = new Set();
    const n = tuning.strings.length;
    for (let base = 0; base <= 12; base++) {
      const lo = Math.max(1, base);
      const hi = base + 3;
      // per string: the frets that give a chord tone inside this window
      const opts = tuning.strings.map((open) => {
        const o = [-1];
        if (ch.pcs.has(open % 12)) o.push(0);
        for (let f = lo; f <= hi; f++) if (ch.pcs.has((open + f) % 12)) o.push(f);
        return o;
      });
      const cur = new Array(n);
      const rec = (i) => {
        if (i === n) return check(cur.slice());
        for (const f of opts[i]) { cur[i] = f; rec(i + 1); }
      };
      const check = (frets) => {
        const k = frets.join(',');
        if (seen.has(k)) return;
        const a = analyse(frets, tuning);
        if (a.sounding.length < tuning.minSound) return;
        // contiguous sounding strings
        if (a.sounding[a.sounding.length - 1] - a.sounding[0] + 1 !== a.sounding.length) return;
        if (a.fingers > 4) return;
        // span (only fretted notes count)
        if (a.fretted.length) {
          const fs = a.fretted.map((i) => frets[i]);
          if (Math.max(...fs) - Math.min(...fs) > 3) return;
        }
        const pcs = new Set(a.sounding.map((i) => (tuning.strings[i] + frets[i]) % 12));
        for (const r of ch.required) if (!pcs.has(r)) return;
        if (tuning.lowBass) {
          const bassPc = (tuning.strings[a.sounding[0]] + frets[a.sounding[0]]) % 12;
          if (bassPc !== ch.bass) return;
        }
        // an open string under a barre isn't playable
        if (a.barre) for (let i = a.barre.from; i <= a.barre.to; i++) if (frets[i] < a.barre.fret) return;
        seen.add(k);
        const open = a.sounding.filter((i) => frets[i] === 0).length;
        const muted = n - a.sounding.length;
        const maxF = a.fretted.length ? Math.max(...a.fretted.map((i) => frets[i])) : 0;
        const cost =
          a.fingers * 1.0 +
          (a.barre ? 2.5 : 0) +
          muted * 0.6 +
          maxF * 0.18 + a.minF * 0.3 +
          (a.fretted.length ? (maxF - a.minF) * 0.3 : 0) -
          (maxF <= 4 ? open * 0.6 : -open * 1.5) -
          (a.sounding.length - tuning.minSound) * 0.35 -
          (a.sounding.length === n ? 0.3 : 0);
        out.push({ frets, base: baseFretOf(frets), barre: a.barre, fingers: a.fingers, cost, minF: a.minF });
      };
      rec(0);
    }
    out.sort((x, y) => x.cost - y.cost);
    // keep a spread of positions: at most 4 per neck position (barre shapes get their own slots), best cost first
    const perPos = {};
    const best = [];
    for (const v of out) {
      const bk = v.minF + (v.barre ? 'b' : '');
      if ((perPos[bk] = (perPos[bk] || 0) + 1) > 4) continue;
      best.push(v);
      if (best.length >= limit) break;
    }
    // best shape first, the rest in order up the neck
    const first = best[0];
    const rest = best.slice(1).sort((x, y) => (x.minF - y.minF) || (x.cost - y.cost));
    out.length = 0;
    if (first) out.push(first, ...rest);
  }
  cache.set(key, out);
  return out;
}

function baseFretOf(frets) {
  const f = frets.filter((x) => x > 0);
  if (!f.length) return 1;
  return Math.max(...f) <= 4 ? 1 : Math.min(...f);
}

export const voicingKey = (v) => v.frets.join(',');

// ---------- SVG ----------

export function renderSvg(v, { name = '', instrument = 'guitar', small = false } = {}) {
  const tuning = TUNINGS[instrument] || TUNINGS.guitar;
  const n = tuning.strings.length;
  const W = 84;
  const H = 104;
  const left = 22;
  const top = 30;
  const gap = (W - left - 10) / (n - 1);
  const fh = 14;
  const rows = 5;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${small ? 62 : W}" class="cd" role="img" aria-label="${esc(name)} chord diagram">`);
  parts.push(`<text x="${W / 2}" y="11" text-anchor="middle" class="cd-name">${esc(name)}</text>`);
  if (!v) {
    parts.push(`<text x="${W / 2}" y="${H / 2 + 8}" text-anchor="middle" class="cd-none">no shape</text></svg>`);
    return parts.join('');
  }
  const base = v.base;
  // nut or fret label
  if (base === 1) parts.push(`<rect x="${left - 1}" y="${top - 3}" width="${gap * (n - 1) + 2}" height="3" class="cd-nut"/>`);
  else parts.push(`<text x="${left - 7}" y="${top + fh * 0.75}" text-anchor="end" class="cd-fret">${base}</text>`);
  for (let r = 0; r <= rows; r++) parts.push(`<line x1="${left}" x2="${left + gap * (n - 1)}" y1="${top + r * fh}" y2="${top + r * fh}" class="cd-grid"/>`);
  for (let s = 0; s < n; s++) parts.push(`<line x1="${left + s * gap}" x2="${left + s * gap}" y1="${top}" y2="${top + rows * fh}" class="cd-grid"/>`);
  v.frets.forEach((f, s) => {
    const x = left + s * gap;
    if (f < 0) parts.push(`<text x="${x}" y="${top - 8}" text-anchor="middle" class="cd-mark">×</text>`);
    else if (f === 0) parts.push(`<circle cx="${x}" cy="${top - 10}" r="3" class="cd-open"/>`);
  });
  if (v.barre) {
    const row = v.barre.fret - base;
    const y = top + row * fh + fh / 2;
    const x1 = left + v.barre.from * gap;
    const x2 = left + v.barre.to * gap;
    parts.push(`<rect x="${x1 - 4.5}" y="${y - 4.5}" width="${x2 - x1 + 9}" height="9" rx="4.5" class="cd-dot"/>`);
  }
  v.frets.forEach((f, s) => {
    if (f <= 0) return;
    if (v.barre && f === v.barre.fret && s >= v.barre.from && s <= v.barre.to) return;
    const y = top + (f - base) * fh + fh / 2;
    parts.push(`<circle cx="${left + s * gap}" cy="${y}" r="4.6" class="cd-dot"/>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const shapeName = (v) => (v ? v.frets.map((f) => (f < 0 ? 'x' : f)).join(' ') : '');
