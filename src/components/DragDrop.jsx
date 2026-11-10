import React, { useEffect, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { cx } from '../ui.jsx';

/** Where the picture of a dragged row sits from the left, kept whole inside the window (on a phone it is nearly as wide as the screen). */
const inWindow = (left, width) => Math.round(Math.max(8, Math.min(left, window.innerWidth - width - 8)));

/**
 * Dragging rows by a grip, with a mouse or a finger: within a list to put it in a new order, and from one box to
 * another (out of a picker into a list, and back out again). Built on pointer events, because the browser's own
 * drag and drop does not work with a finger.
 *
 * A box that can be dropped on is marked `data-drop-zone="<name>"`, and each row in it that counts for the order
 * `data-drop-row` (a row that can be dragged but is in no order, as in a picker, `data-drag-row`). While something is dragged, `drag` says what, where it came from and where it would land
 * (`drag.over` is { zone, index }, the index counted among the rows other than the one being dragged, or null over
 * nothing that accepts it). The page draws the gap at that place with <DropSlot>, and the row itself follows the
 * pointer as <DragGhost>. Letting go calls onDrop({ item, from, to, index }); letting go anywhere else, or pressing
 * Escape, changes nothing.
 *
 * `accepts(item, from, zone)` says whether a row from one box may be dropped on another.
 */
export function useDragDrop({ accepts, onDrop }) {
  const [drag, setDrag] = useState(null); // { item, from, width, height, over }
  const live = useRef(null);              // the same, with the pointer's place, changed without drawing the page again
  const ghost = useRef(null);
  const latest = useRef({ accepts, onDrop });
  latest.current = { accepts, onDrop };

  /** The box under the pointer that takes this row, and the place in it the row would land. */
  const landing = (x, y) => {
    const d = live.current;
    for (const zone of document.querySelectorAll('[data-drop-zone]')) {
      const box = zone.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      const name = zone.dataset.dropZone;
      if (!latest.current.accepts(d.item, d.from, name)) continue;
      // Above the middle of a row is before it; below the last row is the end.
      const rows = [...zone.querySelectorAll('[data-drop-row]')].filter((row) => row !== d.row);
      let index = rows.findIndex((row) => { const r = row.getBoundingClientRect(); return y < r.top + r.height / 2; });
      if (index === -1) index = rows.length;
      return { zone: name, index };
    }
    return null;
  };
  const follow = () => {
    const d = live.current;
    if (ghost.current) ghost.current.style.transform = `translate(${inWindow(d.x - d.dx, ghost.current.offsetWidth)}px, ${Math.round(d.y - d.dy)}px)`;
    const over = landing(d.x, d.y);
    if (over?.zone !== d.over?.zone || over?.index !== d.over?.index) {
      d.over = over;
      setDrag((now) => now && { ...now, over });
    }
  };

  const stop = useRef(() => {});
  useEffect(() => () => stop.current(), []); // leaving the page in the middle of a drag lets go of everything

  const start = (e, item, from) => {
    if (e.button || live.current) return; // the left button or a finger only, and one row at a time
    e.preventDefault();                   // no text is selected while dragging
    e.currentTarget.focus();
    const row = e.currentTarget.closest('[data-drop-row], [data-drag-row]');
    const box = row.getBoundingClientRect();
    live.current = { item, from, row, id: e.pointerId, x: e.clientX, y: e.clientY, dx: e.clientX - box.left, dy: e.clientY - box.top, over: null };
    live.current.over = landing(e.clientX, e.clientY);
    setDrag({ item, from, width: box.width, height: box.height, x: box.left, y: box.top, over: live.current.over });

    // The page scrolls by itself while the row is held near its top or bottom edge, so a list further down can be reached.
    const scroller = row.closest('main') || document.scrollingElement;
    let frame = requestAnimationFrame(function nudge() {
      const d = live.current;
      if (!d) return;
      const edge = scroller.getBoundingClientRect();
      const speed = d.y < edge.top + 56 ? -12 : d.y > Math.min(edge.bottom, window.innerHeight) - 56 ? 12 : 0;
      const before = scroller.scrollTop;
      if (speed) scroller.scrollTop += speed;
      if (scroller.scrollTop !== before) follow();
      frame = requestAnimationFrame(nudge);
    });

    const move = (ev) => {
      if (ev.pointerId !== live.current?.id) return;
      live.current.x = ev.clientX;
      live.current.y = ev.clientY;
      follow();
    };
    const end = (dropped) => {
      const d = live.current;
      stop.current();
      if (dropped && d?.over) latest.current.onDrop({ item: d.item, from: d.from, to: d.over.zone, index: d.over.index });
    };
    const up = (ev) => { if (ev.pointerId === live.current?.id) end(true); };
    const cancel = (ev) => { if (ev.pointerId === live.current?.id) end(false); };
    const key = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); end(false); } };
    // Listened for on the window, not on the grip: the row the grip is in is taken out of the list while it is dragged.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    stop.current = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      live.current = null;
      stop.current = () => {};
      setDrag(null);
    };
  };

  /** What a grip needs to start a drag of `item` out of the box called `from`. */
  const grip = (item, from) => ({ onPointerDown: (e) => start(e, item, from) });
  return { drag, grip, ghost };
}

/** The handle a row is dragged by. It takes the focus too, so the arrow keys can move the row (the page's onKeyDown). */
export const Grip = React.forwardRef(function Grip({ label, dragging, className, ...props }, ref) {
  return (
    <button ref={ref} type="button" aria-label={label} title="Drag to move" {...props}
      className={cx('flex h-8 w-6 shrink-0 touch-none select-none items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-2 focus-visible:outline-brand-500',
        dragging ? 'cursor-grabbing' : 'cursor-grab', className)}>
      <GripVertical size={16} aria-hidden="true" />
    </button>
  );
});

/** The gap that opens where the dragged row would land. */
export function DropSlot({ height, children }) {
  return (
    <li aria-hidden="true" data-drop-slot="" style={{ height: Math.max(40, Math.min(height || 0, 96)) }}
      className="flex items-center justify-center rounded-lg border-2 border-dashed border-brand-400 bg-brand-50 text-[13px] font-medium text-brand-700">
      {children}
    </li>
  );
}

/** The row being dragged, following the pointer. It is only a picture: it takes no clicks and is not read out. */
export function DragGhost({ dnd, children }) {
  const { drag, ghost } = dnd;
  if (!drag) return null;
  const width = Math.min(drag.width, 420, window.innerWidth * 0.72);
  return (
    <div ref={ghost} aria-hidden="true" data-drag-ghost="" style={{ width, transform: `translate(${inWindow(drag.x, width)}px, ${Math.round(drag.y)}px)` }}
      className="pointer-events-none fixed top-0 left-0 z-[80] rotate-1 rounded-lg border border-brand-300 bg-white px-3 py-2 shadow-xl ring-2 ring-brand-500/20">
      {children}
    </div>
  );
}
