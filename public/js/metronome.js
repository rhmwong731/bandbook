// Metronome with a WebAudio look-ahead scheduler (accurate even when the UI thread is busy),
// count-in bars, and beat callbacks. Pure helpers (tapTempo, clampBpm) are DOM/audio free for tests.

export const clampBpm = (n) => Math.min(300, Math.max(30, Math.round(Number(n) || 0)));

// Average of the last few tap intervals (ms, ascending timestamps). Returns bpm or 0 if fewer than 2 taps.
export function tapTempo(times) {
  const t = times.slice(-6);
  if (t.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < t.length; i++) sum += t[i] - t[i - 1];
  return clampBpm(60000 / (sum / (t.length - 1)));
}

export const beatsPerBar = (time) => {
  const m = String(time || '').match(/^(\d+)\s*\/\s*(\d+)/);
  return m ? Math.min(12, Math.max(1, +m[1])) : 4;
};

export class Metronome {
  constructor() {
    this.bpm = 100;
    this.beats = 4;
    this.countBars = 0; // bars of count-in before onStart fires
    this.volume = 0.7;
    this.running = false;
    this.paused = false;
    this.onBeat = null; // (beatIndex, isCountIn) => void
    this.onCountInDone = null;
    this._ctx = null;
    this._timer = 0;
    this._next = 0;
    this._beat = 0;
    this._queue = [];
    this._raf = 0;
  }

  _audio() {
    if (!this._ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return null;
      this._ctx = new AC();
    }
    if (this._ctx.state === 'suspended') this._ctx.resume();
    return this._ctx;
  }

  start() {
    const ctx = this._audio();
    if (!ctx || this.running) return false;
    this.paused = false;
    this._beat = 0;
    this._total = 0;
    this._go(ctx);
    return true;
  }

  // keep the bar position; the next click is the beat after the last one that sounded
  pause() {
    if (!this.running) return;
    this._beat -= this._queue.length;
    this._total -= this._queue.length;
    this._halt();
    this.paused = true;
  }

  resume() {
    const ctx = this._audio();
    if (!ctx || this.running || !this.paused) return false;
    this.paused = false;
    this._go(ctx);
    return true;
  }

  _go(ctx) {
    this.running = true;
    this._next = ctx.currentTime + 0.06;
    this._queue = [];
    this._timer = setInterval(() => this._schedule(), 25);
    this._schedule();
    const tick = () => {
      if (!this.running) return;
      const now = ctx.currentTime;
      while (this._queue.length && this._queue[0].t <= now) {
        const ev = this._queue.shift();
        if (this.onBeat) this.onBeat(ev.beat, ev.countIn);
        if (ev.last && this.onCountInDone) this.onCountInDone();
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _halt() {
    this.running = false;
    clearInterval(this._timer);
    cancelAnimationFrame(this._raf);
    this._queue = [];
  }

  _schedule() {
    const ctx = this._ctx;
    while (this._next < ctx.currentTime + 0.12) {
      const beat = this._beat % this.beats;
      const countBeats = this.countBars * this.beats;
      const countIn = this._total < countBeats;
      this._click(this._next, beat === 0);
      this._queue.push({ t: this._next, beat, countIn, last: countIn && this._total === countBeats - 1 });
      this._next += 60 / this.bpm;
      this._beat++;
      this._total++;
    }
  }

  _click(when, accent) {
    const ctx = this._ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, this.volume), when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g).connect(ctx.destination);
    o.start(when);
    o.stop(when + 0.06);
  }

  stop() {
    this._halt();
    this.paused = false;
    this._beat = 0;
    this._total = 0;
  }
}
