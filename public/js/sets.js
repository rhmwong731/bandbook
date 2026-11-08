// Set list helpers (no DOM, no storage) so they can be unit tested.
// A set item points at a song by Drive id when it has one (same on every band member's device),
// then by local id, then by title as a last resort.

export const itemFor = (song) => ({ id: song.id, driveId: song.driveId || null, title: song.title });

export function resolve(item, songs) {
  return (
    (item.driveId && songs.find((s) => s.driveId === item.driveId)) ||
    (item.id && songs.find((s) => s.id === item.id)) ||
    songs.find((s) => s.title.toLowerCase() === String(item.title || '').toLowerCase()) ||
    null
  );
}

export const resolveAll = (set, songs) => set.items.map((item) => ({ item, song: resolve(item, songs) }));

// Re-point items at the current song records (picks up Drive ids, renamed titles).
export function refreshItems(set, songs) {
  set.items = set.items.map((it) => { const s = resolve(it, songs); return s ? itemFor(s) : it; });
  return set;
}

export function move(items, i, d) {
  const j = i + d;
  if (i < 0 || j < 0 || i >= items.length || j >= items.length) return items;
  const a = items.slice();
  [a[i], a[j]] = [a[j], a[i]];
  return a;
}

// Running time of a set. durationOf(song) -> seconds (0 when unknown). gap = seconds between songs.
export function setStats(set, songs, durationOf) {
  const rows = resolveAll(set, songs);
  const gap = Math.max(0, Number(set.gap) || 0);
  let songsTotal = 0;
  let untimed = 0;
  let count = 0;
  const durations = rows.map(({ song }) => {
    if (!song) return 0;
    count++;
    const d = Math.max(0, durationOf(song) || 0);
    if (d) songsTotal += d; else untimed++;
    return d;
  });
  const gaps = Math.max(0, count - 1) * gap;
  return { durations, count, untimed, songsTotal, gaps, total: songsTotal + gaps };
}

export const serializeSetlist = (set) =>
  JSON.stringify({ v: 1, name: set.name, gap: Number(set.gap) || 0, items: set.items.map((i) => ({ driveId: i.driveId || null, title: i.title })), updatedAt: set.updatedAt || Date.now() });

export function parseSetlist(text) {
  const j = JSON.parse(text);
  return {
    name: String(j.name || 'Set'),
    gap: Number(j.gap) || 0,
    items: (j.items || []).map((i) => ({ id: null, driveId: i.driveId || null, title: String(i.title || '') })),
    updatedAt: j.updatedAt || 0,
  };
}

export const setlistFileName = (set) => (set.name || 'Set').replace(/[\\/:*?"<>|]/g, '-').trim() + '.setlist.json';
