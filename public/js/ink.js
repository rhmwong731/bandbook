// Freehand annotation layer. Strokes live in "page" coordinates (800px-wide logical page),
// so they stay aligned however the page is zoomed on screen.

export class InkLayer {
  constructor(canvas, viewport) {
    this.canvas = canvas;
    this.viewport = viewport;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.undoStack = [];
    this.redoStack = [];
    this.tool = 'off'; // off | pen | highlighter | eraser | text
    this.color = '#d11a2a';
    this.width = 3;
    this.penOnly = true;
    this.onChange = () => {};
    this.askText = async () => window.prompt('Note text');
    this.w = 800; this.h = 1000; this.scale = 1;
    this.cur = null;
    this.touches = new Map();
    this._raf = 0;
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    this._applyMode();
  }

  setData(strokes) {
    this.strokes = strokes || [];
    this.undoStack = [];
    this.redoStack = [];
    this.redraw();
  }

  setTool(tool) { this.tool = tool; this._applyMode(); }
  setPenOnly(v) { this.penOnly = v; this._applyMode(); }

  _applyMode() {
    const on = this.tool !== 'off';
    this.canvas.style.pointerEvents = on ? 'auto' : 'none';
    // We always handle touch-vs-pen ourselves, so the browser must not pan/zoom the canvas.
    this.canvas.style.touchAction = on ? 'none' : 'auto';
    this.canvas.style.cursor = this.tool === 'eraser' ? 'cell' : on ? 'crosshair' : 'default';
  }

  setSize(w, h, scale) {
    this.w = w; this.h = h; this.scale = scale;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.max(1, Math.round(w * scale * dpr));
    this.canvas.height = Math.max(1, Math.round(h * scale * dpr));
    this.dpr = dpr;
    this.redraw();
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.w, ((e.clientY - r.top) / r.height) * this.h];
  }

  _ignored(e) {
    return this.penOnly && e.pointerType === 'touch';
  }

  _down(e) {
    if (this.tool === 'off') return;
    if (this._ignored(e)) {
      // finger in stylus-only mode: scroll the page instead of drawing
      this.touches.set(e.pointerId, e.clientY);
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const [x, y] = this._pos(e);
    if (this.tool === 'text') {
      const color = this.color, size = 14 + this.width * 2;
      this.askText().then((text) => { if (text) this._add({ id: strokeId(), tool: 'text', x, y, text, color, size }); });
      return;
    }
    if (this.tool === 'eraser') {
      this.cur = { erasing: true, removed: [] };
      this._erase(x, y);
      return;
    }
    this.cur = { id: strokeId(), tool: this.tool, color: this.color, width: this.tool === 'highlighter' ? this.width * 5 : this.width, pts: [[x, y, pressure(e)]] };
    this._schedule();
  }

  _move(e) {
    if (this.touches.has(e.pointerId)) {
      const prev = this.touches.get(e.pointerId);
      this.viewport.scrollTop -= e.clientY - prev;
      this.touches.set(e.pointerId, e.clientY);
      return;
    }
    if (!this.cur) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = this._pos(ev);
      if (this.cur.erasing) this._erase(x, y);
      else this.cur.pts.push([x, y, pressure(ev)]);
    }
    if (!this.cur.erasing) this._schedule();
  }

  _up(e) {
    if (this.touches.delete(e.pointerId)) return;
    if (!this.cur) return;
    const c = this.cur;
    this.cur = null;
    if (c.erasing) {
      if (c.removed.length) { this.undoStack.push({ type: 'remove', items: c.removed }); this.redoStack = []; this.onChange(); }
      return;
    }
    this._add(c);
  }

  _add(stroke) {
    this.strokes.push(stroke);
    this.undoStack.push({ type: 'add', stroke });
    this.redoStack = [];
    this.redraw();
    this.onChange();
  }

  _erase(x, y) {
    const r = 14;
    const kept = [];
    let changed = false;
    this.strokes.forEach((s, i) => {
      if (hit(s, x, y, r)) { this.cur.removed.push({ stroke: s, index: i }); changed = true; } else kept.push(s);
    });
    if (changed) { this.strokes = kept; this.redraw(); }
  }

  undo() {
    const a = this.undoStack.pop();
    if (!a) return;
    if (a.type === 'add') this.strokes = this.strokes.filter((s) => s !== a.stroke);
    else for (const it of [...a.items].sort((p, q) => p.index - q.index)) this.strokes.splice(it.index, 0, it.stroke);
    this.redoStack.push(a);
    this.redraw();
    this.onChange();
  }

  redo() {
    const a = this.redoStack.pop();
    if (!a) return;
    if (a.type === 'add') this.strokes.push(a.stroke);
    else { const ids = new Set(a.items.map((i) => i.stroke)); this.strokes = this.strokes.filter((s) => !ids.has(s)); }
    this.undoStack.push(a);
    this.redraw();
    this.onChange();
  }

  clear() {
    if (!this.strokes.length) return;
    const items = this.strokes.map((stroke, index) => ({ stroke, index }));
    this.strokes = [];
    this.undoStack.push({ type: 'remove', items });
    this.redoStack = [];
    this.redraw();
    this.onChange();
  }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.redraw(); });
  }

  redraw() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const k = this.scale * (this.dpr || 1);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    for (const s of this.strokes) drawStroke(ctx, s);
    if (this.cur && !this.cur.erasing) drawStroke(ctx, this.cur);
  }
}

function strokeId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function pressure(e) { return e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5; }
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

export function drawStroke(ctx, s) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  if (s.tool === 'text') {
    ctx.font = `${s.size}px "Bradley Hand", "Segoe Print", "Comic Sans MS", cursive`;
    ctx.textBaseline = 'top';
    s.text.split('\n').forEach((line, i) => ctx.fillText(line, s.x, s.y + i * s.size * 1.2));
    ctx.restore();
    return;
  }
  const p = s.pts;
  if (!p || !p.length) { ctx.restore(); return; }
  if (p.length === 1) {
    ctx.beginPath();
    ctx.arc(p[0][0], p[0][1], Math.max(s.width / 2, 0.8), 0, Math.PI * 2);
    if (s.tool === 'highlighter') { ctx.globalAlpha = 0.35; ctx.globalCompositeOperation = 'multiply'; }
    ctx.fill();
    ctx.restore();
    return;
  }
  if (s.tool === 'highlighter') {
    ctx.globalAlpha = 0.35;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length - 1; i++) { const m = mid(p[i], p[i + 1]); ctx.quadraticCurveTo(p[i][0], p[i][1], m[0], m[1]); }
    ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
    ctx.stroke();
  } else {
    // pen: smoothed segments, width follows stylus pressure
    for (let j = 0; j < p.length; j++) {
      const start = j === 0 ? p[0] : mid(p[j - 1], p[j]);
      const end = j === p.length - 1 ? p[j] : mid(p[j], p[j + 1]);
      ctx.lineWidth = s.width * (0.55 + 0.9 * (p[j][2] ?? 0.5));
      ctx.beginPath();
      ctx.moveTo(start[0], start[1]);
      ctx.quadraticCurveTo(p[j][0], p[j][1], end[0], end[1]);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function hit(s, x, y, r) {
  if (s.tool === 'text') {
    const lines = s.text.split('\n');
    const w = Math.max(...lines.map((l) => l.length)) * s.size * 0.55;
    return x >= s.x - r && x <= s.x + w + r && y >= s.y - r && y <= s.y + lines.length * s.size * 1.2 + r;
  }
  const pad = r + (s.width || 0) / 2;
  const p = s.pts;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[i + 1] || a;
    if (distSeg(x, y, a[0], a[1], b[0], b[1]) <= pad) return true;
  }
  return false;
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
