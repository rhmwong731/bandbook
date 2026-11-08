// Pointer-based drag and drop for list rows. Works with mouse, touch and Apple Pencil
// (HTML5 drag and drop does not work reliably on touch screens).
//
// Rows carry data-kind: "song" | "folder" | "item". Only an element with class "grip" starts a drag,
// so scrolling the list by touch keeps working everywhere else.
//   song   can be dropped on a song (before/after) or on a folder header (into)
//   item   (a song inside a set list) can be dropped on another item (before/after)

export function enableDrag(list, onDrop) {
  // a drag ends with a click on the grip; do not let that open the song
  list.addEventListener('click', (e) => { if (e.target.closest('.grip')) e.stopPropagation(); }, true);

  list.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.grip');
    if (!grip || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const src = grip.closest('li');
    if (!src) return;
    e.preventDefault();
    begin(e, src, grip);
  });

  function begin(e, src, grip) {
    const rect = src.getBoundingClientRect();
    const offY = e.clientY - rect.top;
    const ghost = src.cloneNode(true);
    ghost.classList.add('drag-ghost');
    Object.assign(ghost.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', pointerEvents: 'none', zIndex: 100 });
    document.body.append(ghost);
    src.classList.add('dragging');
    grip.setPointerCapture(e.pointerId);

    let x = e.clientX, y = e.clientY, target = null, pos = null, raf = 0;
    const sk = src.dataset.kind;

    const clear = () => {
      if (target) target.classList.remove('drop-before', 'drop-after', 'drop-into');
      target = null; pos = null;
    };
    const hit = () => {
      clear();
      ghost.style.top = y - offY + 'px';
      const el = document.elementFromPoint(x, y);
      const li = el && el.closest ? el.closest('li') : null;
      if (!li || li === src || !list.contains(li)) return;
      const kind = li.dataset.kind;
      if (sk === 'song' && kind !== 'song' && kind !== 'folder') return;
      if (sk === 'item' && kind !== 'item') return;
      if (sk !== 'song' && sk !== 'item') return;
      if (kind === 'folder') pos = 'into';
      else { const r = li.getBoundingClientRect(); pos = y < r.top + r.height / 2 ? 'before' : 'after'; }
      target = li;
      li.classList.add('drop-' + pos);
    };
    // keep scrolling while the pointer rests near the top or bottom edge of the list
    const tick = () => {
      const lr = list.getBoundingClientRect();
      if (y < lr.top + 36) list.scrollTop -= 12;
      else if (y > lr.bottom - 36) list.scrollTop += 12;
      hit();
      raf = requestAnimationFrame(tick);
    };
    const move = (ev) => { x = ev.clientX; y = ev.clientY; hit(); };
    const finish = (drop) => {
      cancelAnimationFrame(raf);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', cancel);
      try { grip.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      ghost.remove();
      src.classList.remove('dragging');
      const t = target, p = pos;
      clear();
      if (drop && t) onDrop(src, t, p);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', cancel);
    raf = requestAnimationFrame(tick);
  }
}
