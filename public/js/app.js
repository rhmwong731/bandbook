import * as db from './store.js';
import { parseChordPro, renderSheet, convertChordsOverLyrics, makeTransposer, chordsOf, setDirective, parseDuration, formatDuration, parseDefines, setDefine } from './chordpro.js';
import { voicings, renderSvg, TUNINGS, shapeText, parseShape, customVoicing } from './diagram.js';
import { Metronome, tapTempo, clampBpm, beatsPerBar } from './metronome.js';
import { renderDoc, closeDoc } from './docview.js';
import { assess } from './offline.js';
import { buildBackup, restoreBackup, backupName } from './backup.js';
import { InkLayer } from './ink.js';
import * as srv from './server.js';
import { resolveConflict, syncAll, shareSong, shareSetlist, removeSongEverywhere, removeSetEverywhere, keepOffDevice } from './sync.js';
import * as sets from './sets.js';
import { enableDrag } from './dnd.js';
import { byOrder, insertAmong, moveIndex } from './order.js';

const $ = (id) => document.getElementById(id);
const PAGE_W = 800;
const state = { songs: [], sets: [], view: 'songs', setId: null, activeSet: null, cur: null, ink: null, mode: 'play', zoom: 1, filter: '', scrolling: false, parsed: null, showChords: false, stage: false, locked: false };
const ink = new InkLayer($('ink'), $('viewport'));

// ---------- helpers ----------
function askDialog({ message, input = false, ok = 'OK', value = '', single = false }) {
  return new Promise((resolve) => {
    const d = $('dlgAsk');
    const ta = $('askInput');
    $('askMsg').textContent = message;
    ta.hidden = !input;
    ta.value = value;
    ta.rows = single ? 1 : 3;
    ta.onkeydown = single ? (e) => { if (e.key === 'Enter') { e.preventDefault(); $('askOk').click(); } } : null;
    $('askOk').textContent = ok;
    const done = (v) => { if (d.open) d.close(); resolve(v); };
    $('askOk').onclick = () => done(input ? (single ? ta.value.replace(/\s+/g, ' ') : ta.value).trim() : true);
    $('askCancel').onclick = () => done(input ? '' : false);
    d.oncancel = () => done(input ? '' : false);
    d.showModal();
    if (input) ta.focus();
  });
}
ink.askText = () => askDialog({ message: 'Note text', input: true, ok: 'Add note' });

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

const debounce = (fn, ms) => { let h; const d = (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; d.flush = () => { clearTimeout(h); fn(); }; return d; };

function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

const fileSafe = (s) => (s || 'song').replace(/[\\/:*?"<>|]/g, '-').trim();

const NEW_SONG = `{title: New Song}
{artist: }
{key: C}

{start_of_verse: Verse 1}
[C]Lyrics go here with [G]chords inline
{end_of_verse}
`;

const DEMO = `{title: Amazing Grace}
{artist: Traditional (public domain)}
{key: G}
{tempo: 72}
{time: 3/4}

{start_of_verse: Verse 1}
A[G]mazing grace, how [G7]sweet the [C]sound,
That [G]saved a wretch like [D]me.
I [G]once was lost, but [G7]now am [C]found,
Was [G]blind but [D]now I [G]see.
{end_of_verse}

{start_of_verse: Verse 2}
'Twas [G]grace that taught my [G7]heart to [C]fear,
And [G]grace my fears re[D]lieved;
How [G]precious did that [G7]grace ap[C]pear
The [G]hour I [D]first be[G]lieved.
{end_of_verse}
`;

// ---------- song list ----------
async function loadSongs() {
  state.songs = (await db.all('songs')).sort((a, b) => a.title.localeCompare(b.title));
  renderList();
  updateSyncState();
}

function songRow(s) {
  const li = document.createElement('li');
  li.className = 'song';
  li.dataset.kind = 'song';
  li.dataset.id = s.id;
  if (state.cur && state.cur.id === s.id) li.classList.add('active');
  if (!state.filter.trim()) li.append(gripEl());
  const left = document.createElement('div');
  const t = document.createElement('div'); t.className = 't'; t.textContent = s.title;
  const sub = document.createElement('div'); sub.className = 's';
  sub.textContent = [db.isDoc(s) ? (s.kind === 'pdf' ? 'PDF' : 'Image') : '', s.artist, s.key && 'Key ' + s.key, durLabel(s)].filter(Boolean).join(' · ');
  left.append(t, sub);
  li.append(left);
  const badge = document.createElement('span');
  badge.className = 'badge ' + (s.conflict ? 'conflict' : s.dirty || s.folderDirty ? 'dirty' : s.driveId ? 'cloud' : '');
  badge.textContent = s.conflict ? 'conflict' : s.dirty || s.folderDirty ? 'edited' : s.driveId ? 'band' : 'local';
  li.append(badge);
  li.onclick = async () => { await openSong(s.id); $('sidebar').classList.remove('open'); if (s.conflict) offerConflict(s); };
  return li;
}

function folderRow(name, count, open) {
  const li = document.createElement('li');
  li.className = 'folder';
  li.dataset.kind = 'folder';
  li.dataset.folder = name;
  const label = document.createElement('span');
  label.className = 'fname';
  label.append(document.createTextNode((open ? '\u25be ' : '\u25b8 ') + (name || 'Unfiled')));
  const n = document.createElement('span'); n.className = 'fcount'; n.textContent = count;
  label.append(n);
  li.append(label);
  if (name) {
    const m = document.createElement('button');
    m.textContent = '\u22ef';
    m.title = 'Rename or delete folder';
    m.onclick = (e) => { e.stopPropagation(); state.folderMenu = name; $('fTitle').textContent = name; $('dlgFolder').showModal(); };
    li.append(m);
  }
  li.onclick = () => {
    const col = db.settings.get('collapsed', {});
    col[name || '_'] = !col[name || '_'];
    db.settings.set('collapsed', col);
    renderList();
  };
  return li;
}

function renderSongList() {
  const q = state.filter.trim().toLowerCase();
  const ul = $('songlist');
  ul.textContent = '';
  const col = db.settings.get('collapsed', {});
  for (const name of [...db.getFolders(state.songs), '']) {
    const items = state.songs.filter((s) => (s.folder || '') === name && (!q || (s.title + ' ' + s.artist).toLowerCase().includes(q))).sort(byOrder);
    if ((q || !name) && !items.length) continue;
    const open = !!q || !col[name || '_'];
    ul.append(folderRow(name, items.length, open));
    if (!open) continue;
    items.forEach((s) => ul.append(songRow(s)));
  }
}

async function updateSyncState() {
  const songs = state.songs.filter((s) => s.dirty).length;
  const inks = (await db.all('ink')).filter((i) => i.dirty).length;
  const setsN = (await db.all('setlists')).filter((x) => x.dirty).length;
  const n = songs + inks + setsN;
  const last = db.settings.get('lastSync', 0);
  refreshOfflineChip();
  $('syncState').textContent = n ? `${n} unsynced` : last ? 'synced ' + new Date(last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

// ---------- open / render ----------
async function openSong(id, setId = null) {
  await flush();
  const song = state.songs.find((s) => s.id === id) || (await db.get('songs', id));
  if (!song) return;
  state.cur = song;
  state.ink = await db.getInk(song.id);
  state.activeSet = setId;
  metroStop();
  db.settings.set('lastSong', id);
  setMode('play');
  updateSetNav();
  renderList();
}

const durLabel = (song) => { const d = db.durationOf(song); return d ? formatDuration(d) : ''; };

// Capo. The song's {capo: N} is the band's default and the chords are written as they sound. Everyone can set their own
// capo (saved with their annotations, never shared); the chart and chord diagrams then show the shapes to play with it.
const songCapo = () => { const n = parseInt(state.parsed?.meta?.capo ?? state.cur?.info?.capo, 10); return n >= 1 && n <= 11 ? n : 0; };
const myCapo = () => (Number.isInteger(state.ink?.capo) ? state.ink.capo : songCapo());
function capoShift() { return state.cur && !db.isDoc(state.cur) ? myCapo() : 0; }
function updateCapoBtn() {
  const n = myCapo();
  const b = $('btnCapo');
  b.textContent = n ? 'Capo ' + n : 'No capo';
  b.classList.toggle('on', n > 0);
  const own = Number.isInteger(state.ink?.capo) && state.ink.capo !== songCapo();
  b.title = (n ? `Showing the shapes to play with a capo on fret ${n}` : 'Showing the sounding chords') + (own ? `. This is your own setting; the song says ${songCapo() || 'no capo'}.` : '.') + ' Tap to go back to the song\'s capo.';
  $('capoDn').disabled = n <= 0;
  $('capoUp').disabled = n >= 11;
}
function setMyCapo(n) {
  if (!state.ink) return;
  n = Math.max(0, Math.min(11, n));
  if (n === songCapo()) delete state.ink.capo; else state.ink.capo = n;
  state.ink.dirty = true;
  state.ink.updatedAt = Date.now();
  saveInkSoon();
  const keep = $('viewport').scrollTop;
  render();
  $('viewport').scrollTop = keep;
}
$('capoDn').onclick = () => setMyCapo(myCapo() - 1);
$('capoUp').onclick = () => setMyCapo(myCapo() + 1);
$('btnCapo').onclick = () => setMyCapo(songCapo());

async function render() {
  const song = state.cur;
  if (!song) return;
  $('curTitle').textContent = song.title;
  $('sgTitle').textContent = song.title;
  const t = state.ink.transpose || 0;
  $('trLabel').textContent = t > 0 ? '+' + t : String(t);
  if (db.isDoc(song)) {
    state.parsed = null;
    const file = await db.get('files', song.id);
    if (state.cur !== song) return;
    if (!file) {
      closeDoc();
      $('sheet').classList.remove('doc');
      $('sheet').textContent = 'The file for this song is not on this device yet. Try Sync.';
    } else {
      try { await renderDoc($('sheet'), song, file, { root: $('viewport') }); }
      catch (e) { $('sheet').classList.remove('doc'); $('sheet').textContent = 'Could not open this file: ' + e.message; }
      if (state.cur !== song) return;
    }
  } else {
    closeDoc();
    $('sheet').classList.remove('doc');
    state.parsed = parseChordPro(song.text);
    updateCapoBtn();
    updateFitBtn();
    const style = db.settings.get('chordStyle', 'letters');
    renderSheet($('sheet'), state.parsed, { transpose: t, style, capoShift: capoShift() });
    if (style !== 'letters' && !$('sheet').dataset.numerals && !state.numWarned) {
      state.numWarned = true;
      toast('Add a key in Song info to see chords as numbers', 4000);
    }
  }
  layout();
  ink.setData(state.ink.strokes);
  $('viewport').scrollTop = 0;
  drawChordStrip();
  syncMetroPanel();
  setupAudio();
  updateSetNav();
}

// Fit: size the text so the longest line fits the page width without wrapping (the page stays 800px wide, so annotations keep their place)
function applyFit() {
  const sh = $('sheet');
  sh.style.fontSize = '';
  if (!state.ink?.fit || db.isDoc(state.cur)) return;
  sh.classList.add('measure');
  let widest = 0, avail = 0;
  for (const l of sh.querySelectorAll('.line')) { widest = Math.max(widest, l.scrollWidth); avail = Math.max(avail, l.clientWidth); }
  sh.classList.remove('measure');
  if (!widest || !avail) return;
  const fs = Math.max(14, Math.min(30, 22 * 0.96 * (avail / widest)));
  sh.style.fontSize = fs.toFixed(2) + 'px';
}
function updateFitBtn() {
  $('btnFit').hidden = db.isDoc(state.cur);
  $('btnFit').classList.toggle('on', !!state.ink?.fit);
}
$('btnFit').onclick = () => {
  if (!state.ink) return;
  state.ink.fit = !state.ink.fit;
  state.ink.dirty = true;
  state.ink.updatedAt = Date.now();
  saveInkSoon();
  updateFitBtn();
  const keep = $('viewport').scrollTop;
  layout();
  $('viewport').scrollTop = keep;
};

document.fonts?.addEventListener?.('loadingdone', () => { if (state.mode === 'play' && state.cur) layout(); });

function layout() {
  applyFit();
  const vp = $('viewport');
  const s = Math.max(0.3, (vp.clientWidth / PAGE_W) * state.zoom);
  const h = Math.max($('sheet').offsetHeight + 40, vp.clientHeight / s);
  $('page').style.width = PAGE_W + 'px';
  $('page').style.height = h + 'px';
  $('page').style.transform = `scale(${s})`;
  $('scaler').style.width = PAGE_W * s + 'px';
  $('scaler').style.height = h * s + 'px';
  ink.setSize(PAGE_W, h, s);
}

window.addEventListener('resize', debounce(() => { if (state.mode === 'play') layout(); }, 150));

function setMode(mode) {
  state.mode = mode;
  const edit = mode === 'edit';
  $('btnPlay').classList.toggle('on', !edit);
  $('btnEdit').classList.toggle('on', edit);
  $('editorWrap').hidden = !edit;
  $('viewport').hidden = edit;
  $('annobar').hidden = edit;
  const doc = db.isDoc(state.cur);
  $('transposeGroup').hidden = edit || doc;
  $('viewGroup').hidden = edit;
  $('chordStyle').hidden = doc;
  $('btnChords').hidden = doc;
  $('btnEdit').hidden = doc;
  $('chordStrip').hidden = edit || doc || !state.showChords;
  $('zoomGroup').hidden = edit;
  $('scrollGroup').hidden = edit;
  stopScroll();
  if (edit) {
    $('editor').value = state.cur ? state.cur.text : '';
    ink.setTool('off');
  } else {
    render();
    ink.setTool(activeTool);
  }
}

// ---------- persistence ----------
const saveSongSoon = debounce(async () => {
  const song = state.cur; // capture now: the open song can change while the write is pending
  if (!song) return;
  await db.put('songs', song);
  const i = state.songs.findIndex((s) => s.id === song.id);
  if (i >= 0) state.songs[i] = song;
  renderList();
  updateSyncState();
}, 500);

const saveInkSoon = debounce(async () => {
  if (!state.ink) return;
  await db.put('ink', state.ink);
  updateSyncState();
}, 400);

async function flush() {
  saveSongSoon.flush();
  saveInkSoon.flush();
}
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

ink.onChange = () => {
  if (!state.ink) return;
  state.ink.strokes = ink.strokes;
  state.ink.updatedAt = Date.now();
  state.ink.dirty = true;
  saveInkSoon();
};

// ---------- editing ----------
$('editor').addEventListener('input', () => {
  const s = state.cur;
  if (!s) return;
  s.text = $('editor').value;
  s.demo = false;
  db.refreshMeta(s);
  s.dirty = !!s.driveId;
  s.updatedAt = Date.now();
  $('curTitle').textContent = s.title;
  saveSongSoon();
});

function insertAtCursor(text) {
  const ta = $('editor');
  const { selectionStart: a, selectionEnd: b } = ta;
  ta.setRangeText(text, a, b, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

document.querySelectorAll('[data-ins]').forEach((b) => {
  b.onclick = () => insertAtCursor(b.dataset.ins.replace(/\\n/g, '\n'));
});

$('btnConvert').onclick = () => {
  const ta = $('editor');
  const { selectionStart: a, selectionEnd: b } = ta;
  if (a !== b) ta.setRangeText(convertChordsOverLyrics(ta.value.slice(a, b)), a, b, 'select');
  else ta.value = convertChordsOverLyrics(ta.value);
  ta.dispatchEvent(new Event('input'));
  toast('Converted to ChordPro');
};

// ---------- toolbar ----------
$('btnPlay').onclick = () => state.cur && setMode('play');
$('btnEdit').onclick = () => state.cur && !db.isDoc(state.cur) && setMode('edit');
$('btnMenu').onclick = () => $('sidebar').classList.toggle('open');
$('btnCloseSide').onclick = () => $('sidebar').classList.remove('open');
$('sideScrim').onclick = () => $('sidebar').classList.remove('open');
$('search').oninput = (e) => { state.filter = e.target.value; renderList(); };

function transpose(d) {
  if (!state.ink) return;
  const t = (state.ink.transpose || 0) + d;
  state.ink.transpose = ((((t + 11) % 23) + 23) % 23) - 11; // wrap within -11..+11
  state.ink.dirty = true;
  state.ink.updatedAt = Date.now();
  saveInkSoon();
  const keep = $('viewport').scrollTop;
  render();
  $('viewport').scrollTop = keep;
  if (state.ink.strokes.length) toast('Transposing can shift lines slightly; check your annotations', 3500);
}
$('trUp').onclick = () => transpose(1);
$('trDown').onclick = () => transpose(-1);
$('zoomIn').onclick = () => { state.zoom = Math.min(2.5, state.zoom * 1.12); layout(); };
$('zoomOut').onclick = () => { state.zoom = Math.max(0.5, state.zoom / 1.12); layout(); };

// auto-scroll
let last = 0, pos = 0;
function tick(t) {
  if (!state.scrolling) return;
  const vp = $('viewport');
  pos += Number($('scrollSpeed').value) * ((t - last) / 1000);
  last = t;
  vp.scrollTop = pos;
  if (vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 1) return stopScroll();
  requestAnimationFrame(tick);
}
function startScroll() {
  state.scrolling = true;
  $('btnScroll').classList.add('on');
  pos = $('viewport').scrollTop;
  last = performance.now();
  requestAnimationFrame(tick);
}
function stopScroll() {
  state.scrolling = false;
  $('btnScroll').classList.remove('on');
}
$('btnScroll').onclick = () => (state.scrolling ? stopScroll() : startScroll());
$('viewport').addEventListener('wheel', stopScroll, { passive: true });
$('viewport').addEventListener('pointerdown', stopScroll);

// annotation tools
let activeTool = 'off';
document.querySelectorAll('#tools [data-tool]').forEach((b) => {
  b.onclick = () => {
    activeTool = b.dataset.tool;
    document.querySelectorAll('#tools [data-tool]').forEach((x) => x.classList.toggle('on', x === b));
    ink.setTool(activeTool);
    if (activeTool !== 'off') stopScroll();
  };
});
document.querySelectorAll('#colors .swatch').forEach((b) => {
  b.onclick = () => {
    ink.color = b.dataset.color;
    document.querySelectorAll('#colors .swatch').forEach((x) => x.classList.toggle('on', x === b));
    if (activeTool === 'off' || activeTool === 'eraser') $('tools').querySelector('[data-tool="pen"]').click();
  };
});
$('penWidth').onchange = (e) => { ink.width = Number(e.target.value); };
$('inkUndo').onclick = () => ink.undo();
$('inkRedo').onclick = () => ink.redo();
$('inkClear').onclick = async () => { if (ink.strokes.length && await askDialog({ message: 'Erase all your annotations on this song? Undo brings them back.', ok: 'Erase' })) ink.clear(); };
$('penOnly').onchange = (e) => { ink.setPenOnly(e.target.checked); db.settings.set('penOnly', e.target.checked); };

// ---------- song actions ----------
async function newSong() {
  const s = db.makeSong({ text: NEW_SONG, folder: state.cur?.folder || '' });
  await db.put('songs', s);
  await loadSongs();
  await openSong(s.id);
  setMode('edit');
  const ta = $('editor');
  ta.focus();
  ta.setSelectionRange(0, 0);
}

async function importFiles(files) {
  let n = 0, last = null;
  const folder = state.cur?.folder || '';
  for (const f of files) {
    const kind = db.kindOfFile(f.name, f.type);
    if (kind) {
      const doc = db.makeDocSong({ blob: f, kind, mime: f.type, fileName: f.name, folder });
      await db.put('files', { id: doc.id, blob: f, mime: doc.mime, name: f.name });
      await db.put('songs', doc);
      last = doc; n++;
      continue;
    }
    let text = await f.text();
    if (/\.json$/i.test(f.name)) {
      try {
        const b = JSON.parse(text);
        if (b.bandbook && b.song) {
          const s = db.makeSong({ text: b.song.text, folder });
          await db.put('songs', s);
          if (b.ink) await db.put('ink', { songId: s.id, strokes: b.ink.strokes || [], transpose: b.ink.transpose || 0, updatedAt: Date.now(), dirty: true, remoteModified: null });
          last = s; n++;
        }
      } catch { toast(`${f.name}: not a BandBook file`); }
      continue;
    }
    const name = f.name.replace(/\.[^.]+$/, '');
    if (!/\[[^\]]+\]/.test(text) && !/\{\s*(t|title)\s*:/i.test(text)) text = convertChordsOverLyrics(text);
    if (!/\{\s*(t|title)\s*:/i.test(text)) text = `{title: ${name}}\n\n${text}`;
    const s = db.makeSong({ text, fileName: f.name, folder });
    await db.put('songs', s);
    last = s; n++;
  }
  await loadSongs();
  if (last) await openSong(last.id);
  if (n) toast(`Imported ${n} song${n > 1 ? 's' : ''}. PDFs and images can be annotated too.`);
}

$('btnNew').onclick = newSong;
$('btnImport').onclick = () => $('fileInput').click();
$('fileInput').onchange = async (e) => { await importFiles([...e.target.files]); e.target.value = ''; };

// ---------- set lists ----------
async function loadSets() {
  state.sets = (await db.all('setlists')).sort((a, b) => a.name.localeCompare(b.name));
}

async function saveSet(set) {
  set.updatedAt = Date.now();
  set.dirty = !!set.driveId;
  await db.put('setlists', set);
  await loadSets();
  renderList();
  updateSetNav();
  updateSyncState();
}

const currentSet = () => state.sets.find((x) => x.id === state.setId) || null;

function newSetRecord(name) {
  return { id: db.newId(), name, items: [], driveId: null, remoteModified: null, dirty: false, updatedAt: Date.now() };
}

function emptyRow(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

function iconBtn(label, title, fn, disabled = false) {
  const b = document.createElement('button');
  b.className = 'iconbtn';
  b.textContent = label;
  b.title = title;
  b.disabled = disabled;
  b.onclick = (e) => { e.stopPropagation(); fn(); };
  return b;
}

function renderList() {
  const sv = state.view === 'sets';
  $('search').hidden = sv;
  $('footSongs').hidden = sv;
  $('footSets').hidden = !sv;
  $('tabSongs').classList.toggle('on', !sv);
  $('tabSets').classList.toggle('on', sv);
  if (sv) renderSets(); else renderSongList();
}

function renderSets() {
  const ul = $('songlist');
  ul.textContent = '';
  const set = currentSet();
  if (!set) {
    state.setId = null;
    if (!state.sets.length) { ul.append(emptyRow('No set lists yet. Tap + Set to build one.')); return; }
    for (const x of state.sets) {
      const li = document.createElement('li');
      li.className = 'song';
      const left = document.createElement('div');
      const t = document.createElement('div'); t.className = 't'; t.textContent = x.name;
      const xs = sets.setStats(x, state.songs, db.durationOf);
      const sub = document.createElement('div'); sub.className = 's'; sub.textContent = `${x.items.length} song${x.items.length === 1 ? '' : 's'}` + (xs.total ? ' · ' + formatDuration(xs.total) : '');
      left.append(t, sub);
      const badge = document.createElement('span');
      badge.className = 'badge ' + (x.dirty ? 'dirty' : x.driveId ? 'cloud' : '');
      badge.textContent = x.dirty ? 'edited' : x.driveId ? 'band' : 'local';
      li.append(left, badge);
      li.onclick = () => { state.setId = x.id; renderList(); };
      ul.append(li);
    }
    return;
  }

  const head = document.createElement('li');
  head.className = 'setbar';
  const name = document.createElement('span');
  name.className = 'setname';
  name.textContent = set.name;
  head.append(
    iconBtn('‹ Sets', 'Back to all sets', () => { state.setId = null; renderList(); }),
    name,
    iconBtn('⋯', 'Set options', () => { $('sTitle').textContent = set.name; $('sShare').hidden = !!set.driveId; $('sDelete').textContent = set.driveId ? 'Remove from this device' : 'Delete set'; $('sDeleteAll').hidden = !set.driveId; $('dlgSet').showModal(); }),
  );
  ul.append(head);

  const rows = sets.resolveAll(set, state.songs);
  if (!rows.length) { ul.append(emptyRow('Empty set. Tap ⋯, then Add songs.')); return; }
  const st = sets.setStats(set, state.songs, db.durationOf);
  const tot = document.createElement('li');
  tot.className = 'setbar';
  tot.id = 'setTotal';
  tot.style.cssText = 'color:var(--muted);font-size:13px';
  tot.textContent = `${st.count} songs · ${st.total ? formatDuration(st.total) : '0:00'}` +
    (set.gap ? ` (incl. ${formatDuration(st.gaps)} between songs)` : '') +
    (st.untimed ? ` · ${st.untimed} without a length` : '');
  ul.append(tot);

  const start = document.createElement('li');
  start.className = 'setbar';
  const sb = document.createElement('button');
  sb.className = 'primary';
  sb.textContent = 'Start set';
  sb.onclick = () => {
    const first = rows.find((r) => r.song);
    if (!first) return toast('None of these songs are on this device yet. Try Sync.');
    openSong(first.song.id, set.id);
    $('sidebar').classList.remove('open');
  };
  start.append(sb);
  ul.append(start);

  rows.forEach(({ item, song }, i) => {
    const li = document.createElement('li');
    li.className = 'item' + (song ? '' : ' missing');
    li.dataset.kind = 'item';
    li.dataset.index = String(i);
    if (song && state.cur && state.cur.id === song.id && state.activeSet === set.id) li.classList.add('active');
    const num = document.createElement('span'); num.className = 'num'; num.textContent = String(i + 1);
    const mid = document.createElement('div'); mid.className = 'grow';
    const t = document.createElement('div'); t.className = 't'; t.textContent = song ? song.title : item.title;
    const sub = document.createElement('div'); sub.className = 's';
    sub.textContent = song ? [song.artist, song.key && 'Key ' + song.key, durLabel(song)].filter(Boolean).join(' · ') : 'Not on this device. Sync, or add it again.';
    mid.append(t, sub);
    li.append(
      gripEl(), num, mid,
      iconBtn('▲', 'Move up', async () => { set.items = sets.move(set.items, i, -1); await saveSet(set); }, i === 0),
      iconBtn('▼', 'Move down', async () => { set.items = sets.move(set.items, i, 1); await saveSet(set); }, i === rows.length - 1),
      iconBtn('×', 'Remove from set', async () => { set.items.splice(i, 1); await saveSet(set); }),
    );
    li.onclick = () => {
      if (!song) return toast("That song isn't on this device yet. Try Sync, or add it again.", 4000);
      openSong(song.id, set.id);
      $('sidebar').classList.remove('open');
    };
    ul.append(li);
  });
}

// previous / next while playing from a set
function setContext() {
  const set = state.sets.find((x) => x.id === state.activeSet);
  if (!set || !state.cur) return null;
  const list = sets.resolveAll(set, state.songs).filter((r) => r.song);
  const i = list.findIndex((r) => r.song.id === state.cur.id);
  return i < 0 ? null : { set, list, i };
}

function updateSetNav() {
  const c = setContext();
  $('setNav').hidden = !c;
  $('sgPrev').hidden = $('sgNext').hidden = !c;
  if (!c) return;
  const gap = Math.max(0, Number(c.set.gap) || 0);
  const left = c.list.slice(c.i + 1).reduce((a, r) => a + db.durationOf(r.song), 0) + gap * (c.list.length - 1 - c.i);
  $('setPos').textContent = `${c.i + 1} / ${c.list.length} · ${c.set.name}` + (left ? ` · ${formatDuration(left)} left` : '');
  $('setPrev').disabled = $('sgPrev').disabled = c.i === 0;
  $('setNext').disabled = $('sgNext').disabled = c.i === c.list.length - 1;
}

async function stepSet(d) {
  const c = setContext();
  const target = c && c.list[c.i + d];
  if (target) await openSong(target.song.id, c.set.id);
}
$('setPrev').onclick = $('sgPrev').onclick = () => stepSet(-1);
$('setNext').onclick = $('sgNext').onclick = () => stepSet(1);
document.addEventListener('keydown', (e) => {
  if (state.mode !== 'play' || document.querySelector('dialog[open]') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'ArrowRight') stepSet(1);
  else if (e.key === 'ArrowLeft') stepSet(-1);
});

$('tabSongs').onclick = () => { state.view = 'songs'; renderList(); };
$('tabSets').onclick = () => { state.view = 'sets'; renderList(); };
$('btnSet').onclick = async () => {
  const name = await askDialog({ message: 'New set list name', input: true, single: true, ok: 'Create' });
  if (!name) return;
  const set = newSetRecord(name);
  await db.put('setlists', set);
  await loadSets();
  state.view = 'sets';
  state.setId = set.id;
  renderList();
};

function openPick(set) {
  const list = $('pickList');
  const have = new Set(sets.resolveAll(set, state.songs).map((r) => r.song && r.song.id));
  const chosen = [];
  const draw = () => {
    list.textContent = '';
    const f = $('pickSearch').value.trim().toLowerCase();
    for (const s of state.songs) {
      if (f && !(s.title + ' ' + s.artist).toLowerCase().includes(f)) continue;
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = have.has(s.id) || chosen.includes(s.id);
      cb.disabled = have.has(s.id);
      cb.onchange = () => {
        if (cb.checked) chosen.push(s.id); else chosen.splice(chosen.indexOf(s.id), 1);
        $('pickOk').textContent = chosen.length ? `Add ${chosen.length}` : 'Add';
      };
      lab.append(cb, document.createTextNode(s.title + (s.artist ? ' · ' + s.artist : '')));
      list.append(lab);
    }
    if (!list.children.length) list.append(emptyRow('No songs match.'));
  };
  $('pickSearch').value = '';
  $('pickSearch').oninput = draw;
  $('pickOk').textContent = 'Add';
  $('pickOk').onclick = async () => {
    $('dlgPick').close();
    if (!chosen.length) return;
    for (const id of chosen) { const song = state.songs.find((x) => x.id === id); if (song) set.items.push(sets.itemFor(song)); }
    await saveSet(set);
  };
  $('pickCancel').onclick = () => $('dlgPick').close();
  draw();
  $('dlgPick').showModal();
}

$('sClose').onclick = () => $('dlgSet').close();
$('sGap').onclick = async () => {
  $('dlgSet').close();
  const x = currentSet();
  if (!x) return;
  const v = await askDialog({ message: 'Seconds between songs (banter, tuning, changeovers). Used for the set length.', input: true, single: true, ok: 'Save', value: String(x.gap || 0) });
  if (v === '' || v === undefined) return;
  x.gap = Math.max(0, Math.min(600, parseDuration(v) || 0));
  await saveSet(x);
};
$('sAdd').onclick = () => { $('dlgSet').close(); const x = currentSet(); if (x) openPick(x); };
$('sRename').onclick = async () => {
  $('dlgSet').close();
  const x = currentSet();
  if (!x) return;
  const name = await askDialog({ message: 'Rename set', input: true, single: true, ok: 'Rename', value: x.name });
  if (!name || name === x.name) return;
  x.name = name;
  await saveSet(x);
};
$('sDup').onclick = async () => {
  $('dlgSet').close();
  const x = currentSet();
  if (!x) return;
  const c = { ...x, id: db.newId(), name: x.name + ' copy', driveId: null, remoteModified: null, dirty: false, items: x.items.map((i) => ({ ...i })) };
  await db.put('setlists', c);
  await loadSets();
  state.setId = c.id;
  renderList();
};
async function dropCurrentSet(everyone) {
  const x = currentSet();
  if (!x) return;
  if (x.driveId) {
    try {
      if (everyone) await removeSetEverywhere(x); else keepOffDevice(x.id);
    } catch (e) { return toast(e.message, 5000); }
  }
  await db.del('setlists', x.id);
  state.setId = null;
  if (state.activeSet === x.id) state.activeSet = null;
  await loadSets();
  renderList();
  updateSetNav();
}
// Remove from this device (or delete outright if it was never shared). The songs always stay in the library.
$('sDelete').onclick = async () => {
  $('dlgSet').close();
  const x = currentSet();
  if (!x) return;
  const msg = x.driveId
    ? `Remove the set "${x.name}" from this device only?\nThe band keeps it, and it will not come back on your later syncs. Your songs are not touched.`
    : `Delete the set "${x.name}"? Your songs are not touched. This cannot be undone.`;
  if (!(await askDialog({ message: msg, ok: x.driveId ? 'Remove from this device' : 'Delete set' }))) return;
  await dropCurrentSet(false);
};
$('sDeleteAll').onclick = async () => {
  $('dlgSet').close();
  const x = currentSet();
  if (!x) return;
  if (!(await askDialog({ message: `Delete the set "${x.name}" for the whole band?\nEvery member loses it at their next sync. Songs are not touched. This cannot be undone.`, ok: 'Delete for everyone' }))) return;
  await dropCurrentSet(true);
};
$('sShare').onclick = async () => {
  $('dlgSet').close();
  const x = currentSet();
  if (!x) return;
  try {
    toast('Sharing…');
    const missing = await shareSetlist(x);
    await loadSets();
    renderList();
    toast(missing ? `Shared. ${missing} song${missing > 1 ? 's are' : ' is'} not shared with the band yet, so bandmates will not see ${missing > 1 ? 'them' : 'it'} until you share ${missing > 1 ? 'them' : 'it'}.` : 'Set shared with the band', 6500);
  } catch (e) { toast(e.message, 5000); }
};

$('addSetClose').onclick = () => $('dlgAddSet').close();
$('mAddSet').onclick = () => {
  $('dlgMore').close();
  const song = state.cur;
  if (!song) return;
  const box = $('addSetList');
  box.textContent = '';
  const addTo = async (set) => {
    $('dlgAddSet').close();
    if (sets.resolveAll(set, state.songs).some((r) => r.song && r.song.id === song.id)) return toast(`Already in ${set.name}`);
    set.items.push(sets.itemFor(song));
    await saveSet(set);
    toast(`Added to ${set.name}`);
  };
  for (const set of state.sets) {
    const b = document.createElement('button');
    b.textContent = `${set.name} (${set.items.length})`;
    b.onclick = () => addTo(set);
    box.append(b);
  }
  const nb = document.createElement('button');
  nb.textContent = '+ New set…';
  nb.onclick = async () => {
    $('dlgAddSet').close();
    const name = await askDialog({ message: 'New set list name', input: true, single: true, ok: 'Create and add' });
    if (!name) return;
    const set = newSetRecord(name);
    await db.put('setlists', set);
    await addTo(set);
  };
  box.append(nb);
  $('dlgAddSet').showModal();
};

// ---------- drag and drop ----------
function gripEl() {
  const g = document.createElement('span');
  g.className = 'grip';
  g.title = 'Drag to move';
  return g;
}

// Drop a song onto a folder header, or before/after another song.
async function dropSong(id, target) {
  await flush();
  const song = state.songs.find((x) => x.id === id);
  if (!song) return;
  let folder, anchorId = null, after = false;
  if (target.id) {
    const t = state.songs.find((x) => x.id === target.id);
    if (!t || t.id === id) return;
    folder = t.folder || '';
    anchorId = t.id;
    after = !!target.after;
  } else {
    folder = target.folder;
  }
  const moved = (song.folder || '') !== folder;
  if (!moved && !anchorId) return; // dropped on its own folder header
  if (moved) { song.folder = folder; song.folderDirty = !!song.driveId; }
  // manual order is personal to this device; only folder moves go to Drive
  const peers = insertAmong(state.songs.filter((x) => (x.folder || '') === folder), song, anchorId, after);
  for (let i = 0; i < peers.length; i++) {
    if (peers[i].order !== i || peers[i] === song) { peers[i].order = i; await db.put('songs', peers[i]); }
  }
  await reloadKeepCur();
  if (moved) toast(folder ? `Moved to ${folder}` : 'Moved to Unfiled');
}

async function dropItem(set, from, to, after) {
  const next = moveIndex(set.items, from, to, after);
  if (next === set.items) return;
  set.items = next;
  await saveSet(set);
}

enableDrag($('songlist'), (src, tgt, pos) => {
  if (src.dataset.kind === 'song') {
    if (tgt.dataset.kind === 'folder') dropSong(src.dataset.id, { folder: tgt.dataset.folder });
    else dropSong(src.dataset.id, { id: tgt.dataset.id, after: pos === 'after' });
  } else if (src.dataset.kind === 'item') {
    const set = currentSet();
    if (set) dropItem(set, Number(src.dataset.index), Number(tgt.dataset.index), pos === 'after');
  }
});

// ---------- folders ----------
async function reloadKeepCur() {
  await loadSongs();
  if (state.cur) { const f = state.songs.find((x) => x.id === state.cur.id); if (f) state.cur = f; }
  renderList();
}

$('btnFolder').onclick = async () => {
  const name = await askDialog({ message: 'New folder name', input: true, single: true, ok: 'Create' });
  if (!name) return;
  const list = db.getFolders(state.songs);
  if (list.includes(name)) return toast('That folder already exists');
  db.saveFolders([...list, name]);
  renderList();
};

$('fClose').onclick = () => $('dlgFolder').close();
$('fRename').onclick = async () => {
  const old = state.folderMenu;
  $('dlgFolder').close();
  const name = await askDialog({ message: `Rename "${old}" to`, input: true, single: true, ok: 'Rename', value: old });
  if (!name || name === old) return;
  const list = db.getFolders(state.songs);
  if (list.includes(name)) return toast('A folder with that name already exists');
  await flush();
  db.saveFolders(list.map((f) => (f === old ? name : f)));
  for (const song of state.songs) if (song.folder === old) { song.folder = name; song.folderDirty = !!song.driveId; await db.put('songs', song); }
  await reloadKeepCur();
};
$('fDelete').onclick = async () => {
  const name = state.folderMenu;
  $('dlgFolder').close();
  const n = state.songs.filter((x) => x.folder === name).length;
  const msg = `Delete the folder "${name}"?` + (n ? `\nIts ${n} song${n > 1 ? 's' : ''} will move to Unfiled. No songs are deleted.` : '');
  if (!(await askDialog({ message: msg, ok: 'Delete folder' }))) return;
  await flush();
  db.saveFolders(db.getFolders(state.songs).filter((f) => f !== name));
  for (const song of state.songs) if (song.folder === name) { song.folder = ''; song.folderDirty = !!song.driveId; await db.put('songs', song); }
  await reloadKeepCur();
};

async function moveCur(name) {
  $('dlgMove').close();
  await flush();
  const song = state.cur;
  if (!song || (song.folder || '') === name) return;
  const list = db.getFolders(state.songs);
  if (name && !list.includes(name)) db.saveFolders([...list, name]);
  song.folder = name;
  song.folderDirty = !!song.driveId;
  await db.put('songs', song);
  await reloadKeepCur();
  toast(name ? `Moved to ${name}` : 'Moved to Unfiled');
}
$('moveClose').onclick = () => $('dlgMove').close();
$('mMove').onclick = () => {
  $('dlgMore').close();
  const box = $('moveList');
  box.textContent = '';
  const add = (label, value) => {
    const b = document.createElement('button');
    b.textContent = label + ((state.cur.folder || '') === value && value !== null ? '   \u2713' : '');
    b.onclick = () => moveCur(value);
    box.append(b);
  };
  db.getFolders(state.songs).forEach((f) => add(f, f));
  add('Unfiled', '');
  const nb = document.createElement('button');
  nb.textContent = '+ New folder…';
  nb.onclick = async () => {
    $('dlgMove').close();
    const name = await askDialog({ message: 'New folder name', input: true, single: true, ok: 'Create and move' });
    if (name) moveCur(name);
  };
  box.append(nb);
  $('dlgMove').showModal();
};

// More menu
$('btnMore').onclick = () => {
  if (!state.cur) return toast('Open a song first');
  const doc = db.isDoc(state.cur);
  $('mShare').hidden = !!state.cur.driveId;
  $('mDeleteAll').hidden = !state.cur.driveId;
  $('mDelete').textContent = state.cur.driveId ? 'Remove from this device' : 'Delete song';
  $('mExportCho').hidden = $('mExportBundle').hidden = $('mCopy').hidden = doc;
  $('dlgMore').showModal();
};
$('mClose').onclick = () => $('dlgMore').close();
$('mExportCho').onclick = () => { download(fileSafe(state.cur.title) + '.cho', state.cur.text); $('dlgMore').close(); };
$('mExportBundle').onclick = () => {
  const bundle = { bandbook: 1, song: { title: state.cur.title, text: state.cur.text }, ink: { strokes: ink.strokes, transpose: state.ink.transpose || 0 } };
  download(fileSafe(state.cur.title) + '.bandbook.json', JSON.stringify(bundle), 'application/json');
  $('dlgMore').close();
};
$('mPrint').onclick = () => { $('dlgMore').close(); setTimeout(() => window.print(), 100); };
$('mCopy').onclick = async () => {
  await flush();
  const c = db.makeSong({ text: state.cur.text, folder: state.cur.folder || '' });
  c.title = state.cur.title + ' (personal)';
  c.text = c.text.replace(/\{\s*(t|title)\s*:[^}]*\}/i, `{title: ${c.title}}`);
  await db.put('songs', c);
  await db.put('ink', { ...state.ink, songId: c.id, dirty: true, remoteModified: null, strokes: [...ink.strokes] });
  await loadSongs();
  $('dlgMore').close();
  await openSong(c.id);
  toast('Personal copy created. It stays on your devices and is not shared with the band.');
};
$('mShare').onclick = async () => {
  try {
    toast('Sharing…');
    await shareSong(state.cur);
    await loadSongs();
    toast('Shared with the band');
  } catch (e) { toast(e.message, 5000); }
  $('dlgMore').close();
};
async function dropCurrentSong(everyone) {
  const song = state.cur;
  if (!song) return;
  try {
    if (song.driveId) { if (everyone) await removeSongEverywhere(song); else keepOffDevice(song.id); }
  } catch (e) { return toast(e.message, 5000); }
  metroStop();
  await db.del('songs', song.id);
  await db.del('ink', song.id);
  await db.del('files', song.id);
  await db.del('files', 'audio:' + song.id);
  state.cur = null; state.ink = null;
  $('dlgMore').close();
  await loadSongs();
  if (state.songs[0]) await openSong(state.songs[0].id); else showEmpty();
}
// Remove from this device: the band keeps its copy and it will not come back on later syncs
$('mDelete').onclick = async () => {
  const shared = !!state.cur.driveId;
  const msg = shared
    ? `Remove "${state.cur.title}" from this device only?\nThe band keeps it, and it will not come back on your later syncs.`
    : `Delete "${state.cur.title}"? It is not shared with the band, so this cannot be undone.`;
  if (!(await askDialog({ ok: shared ? 'Remove from this device' : 'Delete', message: msg }))) return;
  await dropCurrentSong(false);
};
// Delete for everyone: shared songs only
$('mDeleteAll').onclick = async () => {
  if (!(await askDialog({ ok: 'Delete for everyone', message: `Delete "${state.cur.title}" for the whole band?\nEvery member loses it at their next sync. This cannot be undone.` }))) return;
  await dropCurrentSong(true);
};

function showEmpty() {
  $('sheet').textContent = '';
  $('curTitle').textContent = 'BandBook';
  const p = document.createElement('p');
  p.textContent = 'No songs yet. Tap New or Import.';
  $('sheet').append(p);
  layout();
}

// ---------- settings + sync ----------
function fillSettings() {
  const joined = srv.isJoined();
  $('joinBox').hidden = joined;
  $('joinedBox').hidden = !joined;
  $('setServer').value = srv.serverUrl() || (location.protocol.startsWith('http') ? location.origin : '');
  $('setName').value = srv.memberName() || db.settings.get('lastName', '');
  $('setCode').value = '';
  $('joinedInfo').textContent = joined ? `Joined ${srv.bandName() || 'the band'} as ${srv.memberName()}.` : '';
}
$('btnSettings').onclick = () => { fillSettings(); $('dlgSettings').showModal(); };

$('btnJoin').onclick = async () => {
  const code = $('setCode').value.trim();
  const name = $('setName').value.trim();
  if (!name) return toast('Enter your name first');
  if (!code) return toast('Enter the invite code');
  $('btnJoin').disabled = true;
  try {
    db.settings.set('lastName', name);
    const r = await srv.join($('setServer').value, code, name);
    fillSettings();
    toast(`Welcome to ${r.band}. Tap Sync to get the band's songs.`, 5000);
  } catch (e) { toast(e.message, 6000); }
  finally { $('btnJoin').disabled = false; }
};
$('btnUpdate').onclick = async () => {
  $('btnUpdate').disabled = true;
  toast('Checking for a new version…');
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) { await reg.update().catch(() => {}); await new Promise((r) => setTimeout(r, 1500)); }
  } catch { /* reload anyway */ }
  await flush();
  location.reload();
};
$('btnLink').onclick = async () => {
  const link = $('setLink').value.trim();
  if (!link) return toast('Enter the link code from your other device');
  $('btnLink').disabled = true;
  try {
    const r = await srv.joinWithLink($('setServer').value, link);
    fillSettings();
    toast(`Linked as ${r.member.name}. Tap Sync to get the band's songs and your annotations.`, 6000);
  } catch (e) { toast(e.message, 6000); }
  finally { $('btnLink').disabled = false; }
};
$('btnLinkDev').onclick = async () => {
  try {
    const r = await srv.makeLinkCode();
    await askDialog({ ok: 'Done', message: `Link code: ${r.code.toUpperCase()}\n\nOn your other device open Settings, “Already joined on another device?”, and type it. It works once, for ${r.minutes} minutes.` });
  } catch (e) { toast(e.message, 6000); }
};
$('btnLeave').onclick = async () => {
  if (!(await askDialog({ ok: 'Leave band', message: 'Leave the band on this device? Everything already on this device stays. You can join again with the invite code.' }))) return;
  srv.leave();
  fillSettings();
  updateSyncState();
};
$('btnMembers').onclick = async () => {
  const code = await askDialog({ message: 'Admin code (set up when the band server was installed):', input: true, single: true, ok: 'Show members' });
  if (!code) return;
  try {
    const list = await srv.members(code);
    const ul = $('memberList');
    ul.textContent = '';
    for (const m of list) {
      const li = document.createElement('li');
      li.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;padding:4px 0';
      const t = document.createElement('span');
      t.textContent = `${m.name}  \u00b7  joined ${new Date(m.created).toLocaleDateString()}  \u00b7  last on ${m.last_seen ? new Date(m.last_seen).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'not yet'}`;
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = 'Remove';
      b.onclick = async () => {
        if (!(await askDialog({ ok: 'Remove', message: `Remove ${m.name} from the band? Their device will be locked out of the band.` }))) return;
        try { await srv.removeMember(code, m.id); li.remove(); toast('Removed ' + m.name); } catch (e) { toast(e.message, 5000); }
      };
      li.append(t, b);
      ul.append(li);
    }
    if (!list.length) ul.textContent = 'No members yet.';
    $('dlgSettings').close();
    $('dlgMembers').showModal();
  } catch (e) { toast(e.status === 403 ? 'That admin code is not right.' : e.message, 5000); }
};

$('btnShareAll').onclick = async () => {
  const todo = state.songs.filter((x) => !x.driveId && !x.demo);
  if (!todo.length) return toast('Every song on this device is already shared with the band');
  if (!(await askDialog({ ok: `Share ${todo.length}`, message: `Share ${todo.length} song${todo.length > 1 ? 's' : ''} with the band?\nEveryone in the band will get ${todo.length > 1 ? 'them' : 'it'} at their next sync. Your annotations stay private.` }))) return;
  let n = 0;
  try { for (const x of todo) { await shareSong(x); n++; $('syncState').textContent = `Sharing ${n} of ${todo.length}…`; } }
  catch (e) { toast(`Shared ${n} of ${todo.length}. ${e.message}`, 6000); }
  await loadSongs();
  renderList();
  updateSyncState();
  if (n === todo.length) toast(`Shared ${n} song${n > 1 ? 's' : ''} with the band`);
};
$('btnSync').onclick = async () => {
  if (!srv.isJoined()) { fillSettings(); $('dlgSettings').showModal(); return; }
  const btn = $('btnSync');
  btn.disabled = true;
  try {
    await flush();
    let stats = await syncAll((m) => { $('syncState').textContent = m; });
    for (let i = 0; i < 2 && stats.again; i++) { // something changed while we were uploading: pull it and merge, then upload again
      const more = await syncAll((m) => { $('syncState').textContent = m; });
      stats = { ...more, setCopies: (stats.setCopies || 0) + (more.setCopies || 0), pulled: stats.pulled + more.pulled, pushed: stats.pushed + more.pushed, conflicts: stats.conflicts + more.conflicts, merged: (stats.merged || 0) + (more.merged || 0), ink: stats.ink + more.ink, sets: stats.sets + more.sets };
    }
    await loadSongs();
    await loadSets();
    renderList();
    updateSetNav();
    if (state.cur) {
      const fresh = state.songs.find((s) => s.id === state.cur.id);
      if (fresh && state.mode === 'play') { state.cur = fresh; state.ink = await db.getInk(fresh.id); render(); }
    }
    const bits = [];
    if (stats.pulled) bits.push(`${stats.pulled} downloaded`);
    if (stats.pushed) bits.push(`${stats.pushed} uploaded`);
    if (stats.ink) bits.push(`${stats.ink} annotation set${stats.ink > 1 ? 's' : ''}`);
    if (stats.sets) bits.push(`${stats.sets} set list${stats.sets > 1 ? 's' : ''}`);
    if (stats.merged) bits.push(`${stats.merged} edit${stats.merged > 1 ? 's' : ''} merged with the band's changes`);
    if (stats.setCopies) bits.push(`${stats.setCopies} set list${stats.setCopies > 1 ? 's' : ''} changed by two people (yours kept as “(my edits)”)`);
    if (stats.conflicts) bits.push(`${stats.conflicts} song${stats.conflicts > 1 ? 's' : ''} need${stats.conflicts > 1 ? '' : 's'} a decision`);
    const localOnly = state.songs.filter((x) => !x.driveId && !x.demo).length;
    const note = localOnly ? ` ${localOnly} song${localOnly > 1 ? 's are' : ' is'} only on this device (tagged "local"). Share ${localOnly > 1 ? 'them' : 'it'} from More, or Settings > Your band > Share all local songs.` : '';
    toast((bits.length ? 'Synced: ' + bits.join(', ') : 'Everything is up to date') + '.' + note, localOnly ? 8000 : 4000);
    if (stats.conflicts) await offerConflicts();
  } catch (e) {
    toast(e.message, 6000);
    updateSyncState();
  } finally { btn.disabled = false; }
};

// ---------- dark page / chord style ----------
function applyDark(on, persist = true) {
  $('page').classList.toggle('dark', on);
  $('btnDark').classList.toggle('on', on);
  $('sgDark').classList.toggle('on', on);
  if (persist) db.settings.set('darkPage', on);
}
$('btnDark').onclick = $('sgDark').onclick = () => applyDark(!$('page').classList.contains('dark'));

$('chordStyle').onchange = (e) => {
  db.settings.set('chordStyle', e.target.value);
  state.numWarned = false;
  const keep = $('viewport').scrollTop;
  render().then(() => { $('viewport').scrollTop = keep; });
};

// ---------- chord diagrams ----------
function drawChordStrip() {
  const box = $('chordCards');
  box.textContent = '';
  if (!state.parsed || !state.showChords) return;
  const t = (state.ink.transpose || 0) - capoShift();
  const tr = makeTransposer(state.parsed.meta.key, t);
  const inst = db.settings.get('instrument', 'guitar');
  $('instrument').value = inst;
  const defs = parseDefines(state.cur?.text);
  for (const c of chordsOf(state.parsed)) {
    const name = tr(c);
    const vs = voicings(name, inst);
    // the pick lives in the song itself ({define: ...} line), so it syncs, backs up and exports with the song
    const nStr = TUNINGS[inst].strings.length;
    const saved = (defs[name] || []).find((f) => f.length === nStr);
    let cur = null; // null = first suggestion
    if (saved) cur = vs.find((v) => shapeText(v) === shapeText({ frets: saved })) || customVoicing(saved, inst);
    const card = document.createElement('div');
    card.className = 'ccard';
    card.dataset.chord = name;
    const svg = document.createElement('div');
    const pick = document.createElement('div');
    pick.className = 'cv';
    const prev = document.createElement('button');
    const next = document.createElement('button');
    const edit = document.createElement('button');
    const lab = document.createElement('span');
    prev.textContent = '−';
    next.textContent = '+';
    edit.textContent = '✎';
    prev.title = 'Previous voicing (lower on the neck)';
    next.title = 'Next voicing (higher up the neck)';
    edit.title = 'Type your own fingering, e.g. 3x4432 (empty = back to suggestions)';
    const at = () => (cur && !cur.custom ? vs.findIndex((v) => shapeText(v) === shapeText(cur)) : cur ? -1 : 0);
    const shown = () => cur || vs[0] || null;
    const draw = () => {
      const v = shown();
      svg.innerHTML = renderSvg(v, { name, instrument: inst });
      lab.textContent = cur && cur.custom ? 'custom' : vs.length ? `${Math.max(0, at()) + 1}/${vs.length}` : '';
      prev.disabled = !vs.length || (!cur?.custom && at() <= 0);
      next.disabled = !vs.length || (!cur?.custom && at() >= vs.length - 1);
    };
    const store = () => {
      const song = state.cur;
      if (!song || db.isDoc(song)) return;
      song.text = setDefine(song.text, name, cur && at() !== 0 ? cur.frets : null, nStr);
      db.refreshMeta(song);
      song.dirty = !!song.driveId;
      song.updatedAt = Date.now();
      db.put('songs', song).then(() => { updateSyncState(); });
    };
    const set = (d) => {
      const i = cur?.custom ? (d > 0 ? -1 : vs.length) : Math.max(0, at());
      cur = vs[Math.max(0, Math.min(vs.length - 1, i + d))] || null;
      store();
      draw();
    };
    edit.onclick = () => {
      const t = window.prompt(`Fingering for ${name} (${inst === 'ukulele' ? '4' : '6'} strings, lowest first, x = muted).\nExample: 3x4432, or x.10.12.12.12.10 above the 9th fret.\nLeave empty to go back to the suggestions.`, shapeText(shown() || { frets: [] }));
      if (t === null) return;
      if (!t.trim()) cur = null;
      else {
        const f = parseShape(t, inst);
        if (!f) { toast('Could not read that fingering'); return; }
        cur = vs.find((v) => shapeText(v) === shapeText({ frets: f })) || customVoicing(f, inst);
      }
      store();
      draw();
    };
    prev.onclick = () => set(-1);
    next.onclick = () => set(1);
    pick.append(prev, lab, next, edit);
    card.append(svg, pick);
    box.append(card);
    draw();
  }
  if (!box.children.length) { const e = document.createElement('span'); e.className = 'hint'; e.textContent = 'No chords in this song yet.'; box.append(e); }
}
function toggleChords() {
  state.showChords = !state.showChords;
  $('btnChords').classList.toggle('on', state.showChords);
  $('sgChords').classList.toggle('on', state.showChords);
  $('chordStrip').hidden = !state.showChords || db.isDoc(state.cur) || state.mode === 'edit';
  drawChordStrip();
  layout();
}
$('btnChords').onclick = $('sgChords').onclick = toggleChords;
$('instrument').onchange = (e) => { db.settings.set('instrument', e.target.value); drawChordStrip(); };

// ---------- metronome ----------
const metro = new Metronome();
let tapTimes = [];
const meta = () => (state.cur ? db.metaOf(state.cur) : {});
// the chart's {tempo} is the source of truth; a personal tempo is only used when the chart has none
const effTempo = () => clampBpm(Number(meta().tempo) || (state.ink && state.ink.tempo) || 100);

function buildDots() {
  const box = $('beatDots');
  box.textContent = '';
  for (let i = 0; i < metro.beats; i++) { const d = document.createElement('i'); if (i === 0) d.className = 'first'; box.append(d); }
}
function setBpm(n, personal = true) {
  metro.bpm = clampBpm(n);
  $('mBpm').value = metro.bpm;
  if (personal && !Number(meta().tempo) && state.ink && state.ink.tempo !== metro.bpm) {
    state.ink.tempo = metro.bpm;
    state.ink.updatedAt = Date.now();
    state.ink.dirty = true;
    saveInkSoon();
  }
  if (typeof updateTempoHint === 'function' && state.cur) updateTempoHint();
}
function syncMetroPanel() {
  if (metro.running || metro.paused) return;
  setBpm(effTempo(), false);
  metro.beats = beatsPerBar(meta().time);
  $('mBeats').value = String(metro.beats);
  if (![...$('mBeats').options].some((o) => o.value === String(metro.beats))) $('mBeats').value = '4', (metro.beats = 4);
  buildDots();
  updateTempoHint();
}
function updateTempoHint() {
  const ct = Number(meta().tempo);
  $('mSave').hidden = !state.cur || (ct && clampBpm(ct) === metro.bpm);
  $('mHint').textContent = ct ? (clampBpm(ct) === metro.bpm ? 'song tempo' : `song tempo is ${ct}`) : (state.ink && state.ink.tempo ? 'your tempo (not saved to the song)' : 'no tempo saved for this song');
}
const flashEl = () => $('beatFlash');
function flashBeat(first, countIn) {
  if (!$('mFlash').checked) return;
  const el = flashEl();
  el.classList.remove('go', 'first', 'count');
  void el.offsetWidth; // restart the animation
  el.classList.add('go');
  if (first) el.classList.add('first');
  if (countIn) el.classList.add('count');
}
async function saveTempoToSong() {
  const song = state.cur;
  if (!song) return;
  const bpm = String(metro.bpm);
  if (db.isDoc(song)) song.info = { ...(song.info || {}), tempo: bpm };
  else {
    song.text = setDirective(song.text, 'tempo', bpm);
    db.refreshMeta(song);
    song.dirty = !!song.driveId;
    if (state.mode === 'edit') $('editor').value = song.text;
  }
  song.updatedAt = Date.now();
  await db.put('songs', song);
  await reloadKeepCur();
  updateTempoHint();
  updateSyncState();
  toast(`Saved ${bpm} bpm to “${song.title}”`);
}
function metroUi(state_) { // 'idle' | 'running' | 'paused'
  const go = $('mGo');
  go.textContent = state_ === 'running' ? 'Pause' : state_ === 'paused' ? 'Resume' : 'Start';
  go.classList.toggle('running', state_ === 'running');
  go.dataset.s = state_;
  if (state_ === 'running' && $('metroPanel').classList.contains('opts-open')) { // playing: fold the options away to give the chart room
    $('metroPanel').classList.remove('opts-open'); $('mOpts').classList.remove('on'); $('mOpts').setAttribute('aria-expanded', 'false');
  }
  go.setAttribute('aria-label', state_ === 'running' ? 'Pause metronome' : state_ === 'paused' ? 'Resume metronome' : 'Start metronome');
  $('mStop').hidden = state_ === 'idle';
  const on = state_ !== 'idle';
  $('btnMetro').classList.toggle('on', on || !$('metroPanel').hidden);
  $('sgMetro').classList.toggle('on', on || !$('metroPanel').hidden);
  if (state_ !== 'running') document.querySelectorAll('#beatDots i').forEach((d) => d.classList.remove('on', 'count'));
}
function metroStop() {
  if (!metro.running && !metro.paused) return;
  metro.stop();
  metroUi('idle');
  $('btnMetro').classList.remove('on');
  $('sgMetro').classList.remove('on');
}
function metroPause() {
  metro.pause();
  metroUi('paused');
}
function metroResume() {
  if (!metro.resume()) return toast('This browser has no audio support for the metronome');
  metroUi('running');
}
function metroStart() {
  metro.countBars = Number($('mCount').value);
  metro.volume = Number($('mVol').value);
  metro.beats = Number($('mBeats').value);
  buildDots();
  metro.onBeat = (beat, countIn) => {
    flashBeat(beat === 0, countIn);
    document.querySelectorAll('#beatDots i').forEach((d, i) => { d.classList.toggle('on', i === beat); d.classList.toggle('count', countIn); });
  };
  metro.onCountInDone = () => {
    if ($('mScroll').checked && state.mode === 'play' && !state.scrolling) startScroll();
    if ($('mOnly').checked) setTimeout(metroStop, (60 / metro.bpm) * 1000 * 0.9);
  };
  if (!metro.start()) return toast('This browser has no audio support for the metronome');
  metroUi('running');
}
function toggleMetroPanel() {
  const show = $('metroPanel').hidden;
  $('metroPanel').hidden = !show;
  $('btnMetro').classList.toggle('on', show || metro.running);
  $('sgMetro').classList.toggle('on', show || metro.running);
  if (show) syncMetroPanel(); else metroStop();
  layout();
}
$('btnMetro').onclick = $('sgMetro').onclick = toggleMetroPanel;
// phone layout: toolbar drop-down and on-demand annotation bar
$('btnTools').onclick = (e) => { e.stopPropagation(); const open = !$('topbar').classList.contains('tools-open'); $('topbar').classList.toggle('tools-open', open); $('btnTools').classList.toggle('on', open); };
$('btnAnno').onclick = () => { const on = !$('main').classList.contains('anno-open'); $('main').classList.toggle('anno-open', on); $('btnAnno').classList.toggle('on', on);
  if (on) { $('topbar').classList.remove('tools-open'); $('btnTools').classList.remove('on'); } // the pen bar sits right under the toolbar, which would cover it
  layout(); };
document.addEventListener('pointerdown', (e) => {
  if (!$('topbar').classList.contains('tools-open') || $('topbar').contains(e.target)) return;
  $('topbar').classList.remove('tools-open');
  $('btnTools').classList.remove('on');
});
$('mGo').onclick = () => (metro.running ? metroPause() : metro.paused ? metroResume() : metroStart());
$('mStop').onclick = metroStop;
$('mBpmDown').onclick = () => setBpm(metro.bpm - 1);
$('mBpmUp').onclick = () => setBpm(metro.bpm + 1);
$('mBpm').onchange = (e) => setBpm(e.target.value);
$('mBeats').onchange = (e) => { metro.beats = Number(e.target.value); buildDots(); };
$('mVol').oninput = (e) => { metro.volume = Number(e.target.value); db.settings.set('metroVolume', metro.volume); };
$('mCount').onchange = (e) => { metro.countBars = Number(e.target.value); db.settings.set('countIn', e.target.value); };
$('mSave').onclick = saveTempoToSong;
$('mFlash').onchange = (e) => db.settings.set('metroFlash', e.target.checked);
$('mTap').onclick = () => {
  const now = performance.now();
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2500) tapTimes = [];
  tapTimes.push(now);
  const bpm = tapTempo(tapTimes);
  if (bpm) setBpm(bpm);
};

// ---------- audio ----------
const DIRECT_AUDIO = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)(\?|#|$)/i;
let audioBlobUrl = '';
const mmss = (s) => (Number.isFinite(s) ? formatDuration(s) : '0:00');

async function setupAudio() {
  const el = $('audioEl');
  el.pause();
  $('aPlay').textContent = 'Play';
  if (audioBlobUrl) { URL.revokeObjectURL(audioBlobUrl); audioBlobUrl = ''; }
  const song = state.cur;
  if (!song) return;
  const rec = await db.get('files', 'audio:' + song.id);
  if (state.cur !== song) return;
  const url = db.metaOf(song).audio || '';
  let src = '';
  let link = '';
  if (rec) { src = audioBlobUrl = URL.createObjectURL(rec.blob); }
  else if (url && DIRECT_AUDIO.test(url)) src = url;
  else if (url) link = url;
  $('audioBar').hidden = !(src || link);
  for (const id of ['aPlay', 'aSeek', 'aTime', 'aSpeed']) $(id).hidden = !src;
  $('aLoop').parentElement.hidden = !src;
  $('aLink').hidden = !link;
  if (link) {
    $('aLink').href = /^https?:\/\//i.test(link) ? link : 'https://' + link;
    $('aLink').textContent = 'Open audio: ' + link.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 40);
  }
  if (src) { el.src = src; el.playbackRate = Number($('aSpeed').value); el.loop = $('aLoop').checked; } else el.removeAttribute('src');
  $('aSeek').value = 0;
  $('aTime').textContent = '0:00';
  layout();
}
$('aPlay').onclick = () => { const el = $('audioEl'); if (el.paused) el.play().catch(() => toast('Could not play that audio')); else el.pause(); };
$('audioEl').addEventListener('play', () => ($('aPlay').textContent = 'Pause'));
$('audioEl').addEventListener('pause', () => ($('aPlay').textContent = 'Play'));
$('audioEl').addEventListener('timeupdate', () => {
  const el = $('audioEl');
  if (el.duration) $('aSeek').value = String(Math.round((el.currentTime / el.duration) * 1000));
  $('aTime').textContent = `${mmss(el.currentTime)} / ${mmss(el.duration)}`;
});
$('aSeek').oninput = (e) => { const el = $('audioEl'); if (el.duration) el.currentTime = (Number(e.target.value) / 1000) * el.duration; };
$('aSpeed').onchange = (e) => { $('audioEl').playbackRate = Number(e.target.value); };
$('aLoop').onchange = (e) => { $('audioEl').loop = e.target.checked; };

// ---------- song info ----------
let pendingAudio; // undefined = unchanged, null = remove, File = attach
$('mInfo').onclick = async () => {
  $('dlgMore').close();
  const song = state.cur;
  if (!song) return;
  await flush();
  const m = db.metaOf(song);
  const set = (id, v) => { $(id).value = v || ''; };
  set('iTitle', song.title); set('iArtist', m.artist); set('iKey', m.key); set('iCapo', m.capo);
  set('iTempo', m.tempo); set('iTime', m.time); set('iDur', m.duration); set('iAudio', m.audio);
  pendingAudio = undefined;
  const has = !!(await db.get('files', 'audio:' + song.id));
  $('iDetach').hidden = !has;
  $('iAttachNote').textContent = has ? 'An audio file is attached on this device.' : '';
  $('dlgInfo').showModal();
};
$('iAttach').onclick = () => $('audioFile').click();
$('audioFile').onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  pendingAudio = f;
  $('iDetach').hidden = false;
  $('iAttachNote').textContent = `Will attach ${f.name} when you save.`;
};
$('iDetach').onclick = () => { pendingAudio = null; $('iDetach').hidden = true; $('iAttachNote').textContent = 'Attached file will be removed when you save.'; };
$('formInfo').addEventListener('submit', async (e) => {
  if (!e.submitter || e.submitter.value !== 'save') return;
  const song = state.cur;
  if (!song) return;
  const v = (id) => $(id).value.trim();
  const dur = v('iDur') ? formatDuration(parseDuration(v('iDur'))) : '';
  const fields = { artist: v('iArtist'), key: v('iKey'), capo: v('iCapo'), tempo: v('iTempo'), time: v('iTime'), duration: dur === '0:00' ? '' : dur, audio: v('iAudio') };
  if (db.isDoc(song)) {
    song.title = v('iTitle') || song.title;
    song.artist = fields.artist;
    song.key = fields.key;
    song.info = { capo: fields.capo, tempo: fields.tempo, time: fields.time, duration: fields.duration, audio: fields.audio };
  } else {
    let text = song.text;
    if (v('iTitle')) text = setDirective(text, 'title', v('iTitle'));
    for (const [k, val] of Object.entries(fields)) text = setDirective(text, k, val);
    song.text = text;
    db.refreshMeta(song);
    song.dirty = !!song.driveId;
    if (state.mode === 'edit') $('editor').value = text;
  }
  song.updatedAt = Date.now();
  await db.put('songs', song);
  if (pendingAudio instanceof File) await db.put('files', { id: 'audio:' + song.id, blob: pendingAudio, mime: pendingAudio.type || 'audio/mpeg', name: pendingAudio.name });
  else if (pendingAudio === null) await db.del('files', 'audio:' + song.id);
  pendingAudio = undefined;
  await reloadKeepCur();
  if (state.mode === 'play') { const keep = $('viewport').scrollTop; await render(); $('viewport').scrollTop = keep; }
  else $('curTitle').textContent = song.title;
  updateSyncState();
});

// ---------- conflicts and version history ----------
function offerConflict(song) {
  return new Promise((resolve) => {
    const d = $('dlgConflict');
    const c = song.conflict;
    $('cfTitle').textContent = `“${song.title}”: two versions`;
    $('cfMsg').textContent = `You and ${c.by || 'someone in the band'} both changed the same lines. Nothing is lost: pick which one the band should have, or keep both as separate songs.`;
    $('cfTheirs').value = c.theirs;
    $('cfMine').value = song.text;
    const done = async (choice) => {
      if (d.open) d.close();
      if (choice) {
        const r = await resolveConflict(song, choice);
        await loadSongs();
        renderList();
        if (state.cur && state.cur.id === song.id) { state.cur = state.songs.find((x) => x.id === song.id) || state.cur; await render(); }
        updateSyncState();
        toast(choice === 'both' ? 'Kept both. Your version is the song “(my edits)”.' : choice === 'mine' ? 'Using your version. Sync to share it.' : 'Using the band’s version.');
      }
      resolve();
    };
    $('cfMineBtn').onclick = () => done('mine');
    $('cfTheirsBtn').onclick = () => done('theirs');
    $('cfBoth').onclick = () => done('both');
    $('cfLater').onclick = () => done(null);
    d.oncancel = () => done(null);
    d.showModal();
  });
}
async function offerConflicts() {
  for (const s of state.songs.filter((x) => x.conflict)) await offerConflict(s);
}
$('mHistory').onclick = async () => {
  $('dlgMore').close();
  const song = state.cur;
  if (!song || db.isDoc(song)) return;
  if (!song.driveId) return toast('Version history is kept for songs shared with the band.', 4000);
  const ul = $('histList');
  ul.textContent = 'Loading…';
  $('dlgHistory').showModal();
  try {
    const list = await srv.songHistory(song.id);
    ul.textContent = '';
    if (!list.length) ul.textContent = 'No saved versions yet. They are kept from the next change on.';
    for (const v of list) {
      const li = document.createElement('li');
      const w = document.createElement('div'); w.className = 'when';
      w.textContent = new Date(v.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      const sm = document.createElement('small'); sm.textContent = `${v.by || 'someone'} · ${v.title || ''}`;
      w.append(sm);
      const b = document.createElement('button'); b.textContent = 'Restore';
      b.onclick = async () => {
        try {
          const full = await srv.songVersion(song.id, v.rev);
          if (!(await askDialog({ message: `Put the version from ${w.firstChild.textContent} into “${song.title}”?\nIt becomes an edit you can sync, and the current text stays in the history.`, ok: 'Restore' }))) return;
          await flush();
          song.text = full.text;
          db.refreshMeta(song);
          song.dirty = true;
          song.updatedAt = Date.now();
          await db.put('songs', song);
          $('dlgHistory').close();
          await loadSongs(); renderList(); await render(); updateSyncState();
          toast('Restored. Tap Sync to share it with the band.', 4000);
        } catch (e) { toast(e.message, 5000); }
      };
      li.append(w, b);
      ul.append(li);
    }
  } catch (e) { ul.textContent = e.message; }
};
$('histClose').onclick = () => $('dlgHistory').close();

// ---------- stage view ----------
// ---- stage extras: keep awake, night mode, touch lock ----
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (!on) { await wakeLock?.release(); wakeLock = null; return true; }
    if (!navigator.wakeLock) return false;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    return true;
  } catch { return false; }
}
document.addEventListener('visibilitychange', () => { if (state.stage && document.visibilityState === 'visible' && !wakeLock) keepAwake(true); });

function applyNight(on) {
  document.body.classList.toggle('night', on);
  $('sgNight').classList.toggle('on', on);
}
function setLock(on) {
  state.locked = on;
  $('touchLock').hidden = !on;
  $('stageBar').hidden = on || !state.stage;
  $('unlockBtn').classList.remove('holding');
}
let unlockTimer = 0;
const unlockStart = (e) => { e.preventDefault(); $('unlockBtn').classList.add('holding'); clearTimeout(unlockTimer); unlockTimer = setTimeout(() => setLock(false), 900); };
const unlockCancel = () => { clearTimeout(unlockTimer); $('unlockBtn').classList.remove('holding'); };
$('unlockBtn').addEventListener('pointerdown', unlockStart);
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => $('unlockBtn').addEventListener(ev, unlockCancel));
$('touchLock').addEventListener('contextmenu', (e) => e.preventDefault());
$('sgLock').onclick = () => setLock(true);
$('sgNight').onclick = () => { const on = !document.body.classList.contains('night'); applyNight(on); db.settings.set('nightMode', on); };

function setStage(on) {
  state.stage = on;
  $('app').classList.toggle('stage', on);
  $('stageBar').hidden = !on;
  if (on) {
    if (state.mode === 'edit') setMode('play');
    ink.setTool('off');
    try { document.documentElement.requestFullscreen?.().catch(() => {}); } catch { /* not allowed here */ }
    $('sgScroll').classList.toggle('on', state.scrolling);
    keepAwake(true).then((ok) => { if (!ok) toast('Could not keep the screen awake here. Turn off auto-lock in your device settings before the gig.', 5000); });
    if (db.settings.get('nightMode', false)) applyNight(true);
  } else {
    setLock(false);
    applyNight(false);
    keepAwake(false);
    ink.setTool(activeTool);
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* ignore */ }
  }
  setTimeout(layout, 30);
}
$('btnStage').onclick = () => state.cur && setStage(true);
$('sgExit').onclick = () => setStage(false);
$('sgMore').onclick = () => { const on = $('stageBar').classList.toggle('more'); $('sgMore').classList.toggle('on', on); };
$('mOpts').onclick = () => { const on = $('metroPanel').classList.toggle('opts-open'); $('mOpts').classList.toggle('on', on); $('mOpts').setAttribute('aria-expanded', String(on)); };
$('sgScroll').onclick = () => { $('btnScroll').click(); $('sgScroll').classList.toggle('on', state.scrolling); };
$('sgBig').onclick = () => $('zoomIn').onclick();
$('sgSmall').onclick = () => $('zoomOut').onclick();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.stage && !document.querySelector('dialog[open]')) { if (state.locked) setLock(false); else setStage(false); }
});
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && state.stage && !state.locked) setStage(false); });

// ---------- backup ----------
$('btnBackup').onclick = async () => {
  try {
    await flush();
    const b = await buildBackup();
    download(backupName(), JSON.stringify(b), 'application/json');
    toast(`Backup saved: ${b.songs.length} songs, ${b.setlists.length} sets`);
  } catch (e) { toast('Backup failed: ' + e.message, 5000); }
};
let restoreMode = 'merge';
$('btnRestoreMerge').onclick = () => { restoreMode = 'merge'; $('restoreInput').click(); };
$('btnRestoreAll').onclick = () => { restoreMode = 'replace'; $('restoreInput').click(); };
$('restoreInput').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let j;
  try { j = JSON.parse(await f.text()); } catch { return toast('That file is not a BandBook backup.', 4000); }
  if (!j || j.app !== 'bandbook') return toast('That file is not a BandBook backup.', 4000);
  if (restoreMode === 'replace' && !(await askDialog({ ok: 'Replace everything', message: `Replace everything on this device with the backup (${j.songs.length} songs)? Anything not in the backup is lost.` }))) return;
  try {
    await flush();
    metroStop();
    const n = await restoreBackup(j, restoreMode);
    $('dlgSettings').close();
    await loadSongs();
    await loadSets();
    state.cur = null;
    const first = state.songs[0];
    if (first) await openSong(first.id); else showEmpty();
    renderList();
    toast(`Restored ${n.songs} songs, ${n.files} files, ${n.setlists} sets` + (n.skipped ? ` (${n.skipped} already newer here)` : ''), 5000);
  } catch (err) { toast('Restore failed: ' + err.message, 6000); }
};

// ---------- ready for offline ----------
function swStatus() {
  return new Promise(async (resolve) => {
    if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return resolve({ supported: false });
    const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
    const controlled = !!navigator.serviceWorker.controller;
    if (!reg || !reg.active) return resolve({ supported: true, controlled: false });
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve({ supported: true, controlled }), 1500);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve({ supported: true, controlled, ...e.data }); };
    reg.active.postMessage({ type: 'status' }, [ch.port2]);
  });
}
async function offlineReport() {
  const songs = state.songs;
  let missing = 0;
  for (const s of songs) if (db.isDoc(s) && !(await db.get('files', s.id))) missing++;
  const dirty = songs.filter((s) => s.dirty).length + (await db.all('ink')).filter((x) => x.dirty).length + (await db.all('setlists')).filter((x) => x.dirty).length;
  const last = db.settings.get('lastSync', 0);
  const persisted = (await navigator.storage?.persisted?.().catch(() => false)) || false;
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return { r: assess({ sw: await swStatus(), songs: songs.length, missingFiles: missing, unsynced: dirty, lastSync: last, lastSyncText: last ? new Date(last).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '', persisted, installed }), persisted };
}
async function refreshOfflineChip() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return; // chip stays hidden where it can't apply
  const { r } = await offlineReport();
  const chip = $('offlineChip');
  chip.hidden = false;
  chip.className = 'offchip ' + r.level;
  chip.textContent = r.label + (navigator.onLine ? '' : ' (offline now)');
}
async function showOfflineDialog() {
  const { r, persisted } = await offlineReport();
  $('offTitle').textContent = r.label;
  const ul = $('offList');
  ul.textContent = '';
  for (const it of r.items) {
    const li = document.createElement('li');
    li.className = it.ok === true ? 'good' : it.ok === 'warn' ? 'warn' : 'bad';
    const mk = document.createElement('span');
    mk.className = 'mk';
    mk.textContent = it.ok === true ? '✓' : it.ok === 'warn' ? '!' : '✕';
    const tx = document.createElement('span');
    tx.textContent = it.text;
    if (it.hint) { const h = document.createElement('span'); h.className = 'hintline'; h.textContent = it.hint; tx.append(h); }
    li.append(mk, tx);
    ul.append(li);
  }
  $('offProtect').hidden = persisted || !navigator.storage?.persist;
  if (!$('dlgOffline').open) $('dlgOffline').showModal();
  refreshOfflineChip();
}
$('offlineChip').onclick = showOfflineDialog;
$('offRefresh').onclick = showOfflineDialog;
$('offProtect').onclick = async () => {
  const ok = await navigator.storage.persist().catch(() => false);
  toast(ok ? 'Storage protected' : 'The browser declined. Adding the app to the home screen usually fixes this.', 4500);
  showOfflineDialog();
};
window.addEventListener('online', refreshOfflineChip);
window.addEventListener('offline', refreshOfflineChip);

// ---------- boot ----------
async function boot() {
  ink.setPenOnly(db.settings.get('penOnly', true));
  $('penOnly').checked = db.settings.get('penOnly', true);
  $('chordStyle').value = db.settings.get('chordStyle', 'letters');
  $('mVol').value = db.settings.get('metroVolume', 0.7);
  $('mCount').value = db.settings.get('countIn', '1');
  $('mFlash').checked = !!db.settings.get('metroFlash', false);
  metro.volume = Number($('mVol').value);
  applyDark(db.settings.get('darkPage', false));
  await loadSongs();
  await loadSets();
  if (!state.songs.length && !db.settings.get('seeded', false)) {
    const demo = db.makeSong({ text: DEMO });
    demo.demo = true; // unedited sample song: replaced by the band's songs on first sync
    await db.put('songs', demo);
    db.settings.set('seeded', true);
    await loadSongs();
  }
  const id = db.settings.get('lastSong', '');
  const first = state.songs.find((s) => s.id === id) || state.songs[0];
  if (first) await openSong(first.id); else showEmpty();
  try {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').then(() => setTimeout(refreshOfflineChip, 2500)).catch(() => {});
    navigator.storage?.persist?.().catch(() => {});
  } catch { /* not available here */ }
}
boot();
