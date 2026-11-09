// Three-way text merge by lines, so two people (or two devices) editing different parts of a song
// do not need a "(my edits)" copy. merge3(base, mine, theirs) returns the merged text, or null when
// both sides changed the same lines.
const MAX_LINES = 1500;

function hunks(a, b) { // changes turning a into b: [{ s, e, lines }] replacing a[s..e) with lines
  const n = a.length, m = b.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { s: i, e: i, lines: [] };
    if (j < m && (i >= n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) cur.lines.push(b[j++]);
    else { i++; cur.e = i; }
  }
  flush();
  return out;
}

export function merge3(base, mine, theirs) {
  if (mine === theirs) return mine;
  if (base === mine) return theirs;
  if (base === theirs) return mine;
  const B = base.split('\n'), M = mine.split('\n'), T = theirs.split('\n');
  if (B.length > MAX_LINES || M.length > MAX_LINES || T.length > MAX_LINES) return null;
  const hm = hunks(B, M), ht = hunks(B, T);
  const out = [];
  let pos = 0, i = 0, j = 0;
  const same = (x, y) => x.s === y.s && x.e === y.e && x.lines.join('\n') === y.lines.join('\n') && x.lines.length === y.lines.length;
  while (i < hm.length || j < ht.length) {
    const a = hm[i], b = ht[j];
    let h;
    const bothReplace = a && b && a.e > a.s && b.e > b.s;
    const clash = a && b && (bothReplace ? a.s < b.e && b.s < a.e : a.s <= b.e && b.s <= a.e); // two plain replacements may touch; anything else must not
    if (clash) {
      if (!same(a, b)) return null;
      h = a; i++; j++;
    } else if (a && (!b || a.s < b.s || (a.s === b.s && a.e <= b.e))) { h = a; i++; }
    else { h = b; j++; }
    out.push(...B.slice(pos, h.s), ...h.lines);
    pos = h.e;
  }
  out.push(...B.slice(pos));
  return out.join('\n');
}
