// PDF / image songs. Pages are stacked vertically inside one 800px-wide "paper" so the ink layer,
// zoom and scrolling work exactly like they do for chord sheets. pdf.js loads lazily the first time a PDF opens.
const PAGE_W = 800;
const GAP = 10;

let libP = null;
let session = null; // the currently rendered document, so a new render can cancel it

const textOf = (id) => document.getElementById(id)?.textContent || '';

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('Could not load the PDF engine (vendor/pdf.min.js).'));
    document.head.append(s);
  });
}

export function loadPdfJs() {
  libP ||= (async () => {
    if (!window.pdfjsLib) {
      const inline = textOf('bb-pdfjs'); // single-file builds embed the engine in the page
      if (inline) {
        const s = document.createElement('script');
        s.textContent = inline;
        document.head.append(s);
      } else {
        await loadScript('vendor/pdf.min.js');
      }
    }
    const lib = window.pdfjsLib;
    const worker = textOf('bb-pdfjs-worker');
    if (!worker) {
      lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    } else {
      // single-file build: the worker source is embedded. Prefer a real worker from a blob;
      // where the host page forbids that, run the worker code on the main thread instead.
      let url = '';
      try {
        url = URL.createObjectURL(new Blob([worker], { type: 'text/javascript' }));
        new Worker(url).terminate();
        lib.GlobalWorkerOptions.workerSrc = url;
      } catch {
        const s = document.createElement('script');
        s.textContent = worker;
        document.head.append(s);
        window.pdfjsWorker = window['pdfjs-dist/build/pdf.worker'] || window.pdfjsWorker;
        lib.GlobalWorkerOptions.workerSrc = url || 'vendor/pdf.worker.min.js';
      }
    }
    return lib;
  })().catch((e) => { libP = null; throw e; });
  return libP;
}

export function closeDoc() {
  if (!session) return;
  session.dead = true;
  session.io?.disconnect();
  session.pdf?.destroy?.();
  if (session.url) URL.revokeObjectURL(session.url);
  session = null;
}

// Fills `host` with the pages and returns when their boxes are laid out (canvases paint lazily afterwards).
export async function renderDoc(host, song, file, { root } = {}) {
  closeDoc();
  const me = (session = { dead: false });
  host.textContent = '';
  host.classList.add('doc');
  const wrap = document.createElement('div');
  wrap.className = 'docpages';
  host.append(wrap);

  if (song.kind === 'image') {
    const img = new Image();
    me.url = URL.createObjectURL(file.blob);
    img.className = 'docimg';
    img.draggable = false;
    img.src = me.url;
    await img.decode().catch(() => {});
    if (me.dead) return;
    const h = img.naturalWidth ? Math.round((img.naturalHeight / img.naturalWidth) * PAGE_W) : 1000;
    img.style.cssText = `width:${PAGE_W}px;height:${h}px`;
    wrap.append(img);
    return { pages: 1 };
  }

  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.blob.arrayBuffer()) }).promise;
  if (me.dead) { pdf.destroy?.(); return; }
  me.pdf = pdf;
  const boxes = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = PAGE_W / base.width;
    const box = document.createElement('div');
    box.className = 'docpage';
    box.style.cssText = `width:${PAGE_W}px;height:${Math.round(base.height * scale)}px;margin-bottom:${GAP}px`;
    box.dataset.n = n;
    wrap.append(box);
    boxes.push({ box, page, scale, done: false });
  }
  const paint = async (b) => {
    if (b.done || me.dead) return;
    b.done = true;
    const out = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    const vp = b.page.getViewport({ scale: b.scale * out });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    c.style.cssText = `width:${PAGE_W}px;height:${Math.round(vp.height / out)}px`;
    try {
      await b.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      if (!me.dead) b.box.append(c);
    } catch { b.done = false; }
  };
  if ('IntersectionObserver' in window) {
    me.io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) paint(boxes.find((b) => b.box === e.target)); }), { root: root || null, rootMargin: '900px 0px' });
    boxes.forEach((b) => me.io.observe(b.box));
  } else {
    boxes.forEach(paint);
  }
  return { pages: pdf.numPages };
}
