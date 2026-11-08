// Ordering helpers (pure, unit tested).

// Manual order first (song.order), then alphabetical. Songs never reordered have no `order`.
export const byOrder = (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title);

// Peers of a folder with `moving` inserted next to `anchorId` (or at the end when there is no anchor).
export function insertAmong(peers, moving, anchorId, after) {
  const rest = peers.filter((s) => s.id !== moving.id).sort(byOrder);
  let i = rest.length;
  if (anchorId) {
    const k = rest.findIndex((s) => s.id === anchorId);
    if (k >= 0) i = k + (after ? 1 : 0);
  }
  rest.splice(i, 0, moving);
  return rest;
}

// Move items[from] so it lands before/after items[to].
export function moveIndex(items, from, to, after) {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  let t = to + (after ? 1 : 0);
  const a = items.slice();
  const [m] = a.splice(from, 1);
  if (from < t) t--;
  a.splice(t, 0, m);
  return a;
}
