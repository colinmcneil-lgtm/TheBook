import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { cx } from '../ui.jsx';
import { nudgeFor, swallowClick, waitAtEdge, zoneAt } from '../drag-zones.js';

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
 *
 * A row can also be picked up by itself rather than by a grip (`press`, for the people in a job's pipeline on the
 * job board): a mouse picks it up once it has moved a few pixels with the button held, so a click is still a click;
 * a finger picks it up once it has been held still for a moment, so a finger sliding over the rows scrolls the page
 * as it always did. With `scrollInside`, a box the row is in that scrolls by itself (a column of the job board) is
 * scrolled while the row is held near its top or bottom edge, before the page is. There, a box only starts scrolling
 * once the row has been held near its edge for a moment (see waitAtEdge), so a stage near the foot of a column can be
 * dropped on without the column running away under it.
 */
export function useDragDrop({ accepts, onDrop, scrollInside = false }) {
  const [drag, setDrag] = useState(null); // { item, from, width, height, over }
  const live = useRef(null);              // the same, with the pointer's place, changed without drawing the page again
  const ghost = useRef(null);
  const latest = useRef({ accepts, onDrop });
  latest.current = { accepts, onDrop };

  /** The box under the pointer that takes this row, and the place in it the row would land. */
  const landing = (x, y) => {
    const d = live.current;
    // Only what can be seen counts. A box scrolled out of sight still has a place on the page, under the bar across
    // the top or past the edge of the window, and a row let go there must not land in it.
    const seen = d.scroller.getBoundingClientRect();
    if (x < Math.max(seen.left, 0) || x > Math.min(seen.right, window.innerWidth) || y < Math.max(seen.top, 0) || y > Math.min(seen.bottom, window.innerHeight)) return null;
    const zones = [...document.querySelectorAll('[data-drop-zone]')];
    // Which boxes around each zone scroll does not change during a drag: worked out once a zone, not at every move.
    d.around ??= new Map();
    const around = (zone) => { if (!d.around.has(zone)) d.around.set(zone, scrollingBoxes(zone)); return d.around.get(zone); };
    const name = zoneAt(zones.map((zone) => ({ name: zone.dataset.dropZone, box: zone.getBoundingClientRect(), clips: around(zone).map((box) => box.getBoundingClientRect()) })),
      x, y, (zone) => latest.current.accepts(d.item, d.from, zone));
    if (name === null) return null;
    const zone = zones.find((z) => z.dataset.dropZone === name);
    // Above the middle of a row is before it; below the last row is the end.
    const rows = [...zone.querySelectorAll('[data-drop-row]')].filter((row) => row !== d.row);
    let index = rows.findIndex((row) => { const r = row.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (index === -1) index = rows.length;
    return { zone: name, index };
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

  /**
   * Pick a row up. `at` is where the pointer went down on it, and `now` where it is now (further on, when a row is
   * picked up by `press` once it has moved, or been held). `finger` says the row is held by a finger. `onEnd` is
   * told when the drag stops, for whatever reason, and whether the button is let go by then (not after Escape).
   */
  const begin = ({ el, item, from, id, at, now, finger, onEnd }) => {
    const row = el.closest('[data-drop-row], [data-drag-row]');
    const box = row.getBoundingClientRect();
    const scroller = row.closest('main') || document.scrollingElement;
    // The boxes that scroll while the row is held near their edges, the one nearest the row first; the page last.
    const scrollers = scrollInside ? [...scrollingBoxes(row).filter((b) => b !== scroller), scroller] : [scroller];
    live.current = { item, from, row, scroller, finger, id, x: now.x, y: now.y, dx: at.x - box.left, dy: at.y - box.top, over: null };
    live.current.over = landing(now.x, now.y);
    setDrag({ item, from, width: box.width, height: box.height, x: now.x - (at.x - box.left), y: now.y - (at.y - box.top), over: live.current.over });

    // The page scrolls by itself while the row is held near its top or bottom edge, so a list further down can be reached.
    const near = scrollers.map(() => null); // since when the row has been near each box's edge (with scrollInside)
    let frame = requestAnimationFrame(function nudge(time) {
      const d = live.current;
      if (!d) return;
      for (const [i, el] of scrollers.entries()) {
        const edge = el.getBoundingClientRect();
        const inner = i < scrollers.length - 1;
        let speed = nudgeFor({ left: edge.left, right: edge.right, top: inner ? Math.max(edge.top, 0) : edge.top, bottom: Math.min(edge.bottom, window.innerHeight) }, d.x, d.y, inner ? { inner, edge: 44 } : {});
        if (scrollInside) ({ since: near[i], speed } = waitAtEdge(near[i], speed, time));
        const before = el.scrollTop;
        if (speed) el.scrollTop += speed;
        if (el.scrollTop !== before) { follow(); break; } // a column that has scrolled leaves the page where it is
      }
      frame = requestAnimationFrame(nudge);
    });

    const move = (ev) => {
      if (ev.pointerId !== live.current?.id) return;
      // The mouse is moving with no button held: it was let go where the page could not see (over another window,
      // say). Nothing is dropped; otherwise the row would follow the pointer until the next click.
      if (ev.pointerType === 'mouse' && ev.buttons === 0) { end(false); return; }
      live.current.x = ev.clientX;
      live.current.y = ev.clientY;
      follow();
    };
    const end = (dropped, released = true) => {
      const d = live.current;
      stop.current(released);
      if (dropped && d?.over) latest.current.onDrop({ item: d.item, from: d.from, to: d.over.zone, index: d.over.index });
    };
    const up = (ev) => { if (ev.pointerId === live.current?.id) end(true); };
    const cancel = (ev) => { if (ev.pointerId === live.current?.id) end(false); };
    const key = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); end(false, false); } }; // the button is still held
    const away = () => end(false); // another window or tab was switched to in the middle of a drag
    // Listened for on the window, not on the grip: the row the grip is in is taken out of the list while it is dragged.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', away);
    // The wheel or the trackpad scrolls the page under a row that is being held still: the place it would land
    // has moved though the pointer has not. (Scrolling is not heard from below, so it is listened for on the way down.)
    window.addEventListener('scroll', follow, { capture: true, passive: true });
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    stop.current = (released = true) => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('scroll', follow, { capture: true });
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      live.current = null;
      stop.current = () => {};
      setDrag(null);
      onEnd?.(released);
    };
  };

  const start = (e, item, from) => {
    if (e.button || live.current) return; // the left button or a finger only, and one row at a time
    e.preventDefault();                   // no text is selected while dragging
    e.currentTarget.focus();
    const at = { x: e.clientX, y: e.clientY };
    begin({ el: e.currentTarget, item, from, id: e.pointerId, at, now: at, finger: e.pointerType === 'touch' });
  };

  /**
   * A row pressed by itself, not by a grip. Nothing happens until the mouse has moved a few pixels with its button
   * held, or a finger has stayed still for a moment: until then a click is a click and a finger that slides scrolls
   * the page. Once the row has been picked up, the click the browser sends when it is let go is not passed on, so a
   * drag never also opens what the row opens.
   */
  const pressed = (e, item, from) => {
    if (e.button || live.current || waiting.current) return;
    const el = e.currentTarget, id = e.pointerId, finger = e.pointerType === 'touch';
    const at = { x: e.clientX, y: e.clientY }, now = { ...at };
    let timer = null;
    const forget = () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerup', forget);
      window.removeEventListener('pointercancel', forget);
      window.removeEventListener('keydown', escape, true);
      waiting.current = null;
    };
    const pickUp = () => {
      forget();
      if (!el.isConnected) return;
      window.getSelection()?.removeAllRanges();
      begin({ el, item, from, id, at, now, finger, onEnd: swallowClick(window) });
      if (finger) navigator.vibrate?.(8); // a small tap, where a phone has one, to say the row has come away
    };
    const moved = (ev) => {
      if (ev.pointerId !== id) return;
      now.x = ev.clientX;
      now.y = ev.clientY;
      const far = Math.hypot(now.x - at.x, now.y - at.y);
      if (finger) { if (far > FINGER_SLIP) forget(); } // the finger is scrolling the page, not holding the row
      else if (ev.buttons === 0) forget();
      else if (far > MOUSE_START) pickUp();
    };
    const escape = (ev) => { if (ev.key === 'Escape') forget(); };
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerup', forget);
    window.addEventListener('pointercancel', forget);
    window.addEventListener('keydown', escape, true);
    if (finger) timer = setTimeout(pickUp, HOLD);
    waiting.current = forget;
  };
  const waiting = useRef(null);
  useEffect(() => () => waiting.current?.(), []);

  /**
   * While a finger is dragging a row, the page must not also scroll under it. That can only be stopped from a
   * listener that was there before the finger came down, and that the browser has been told may stop it, so a box
   * holding rows that are picked up with `press` is given one with `touchArea`.
   */
  const touchArea = useCallback((el) => {
    if (!el) return undefined;
    const still = (ev) => { if (live.current?.finger) ev.preventDefault(); };
    el.addEventListener('touchmove', still, { passive: false });
    // A long press would otherwise open the browser's own menu, or select a word, on some phones.
    const noMenu = (ev) => { if (live.current || waiting.current) ev.preventDefault(); };
    el.addEventListener('contextmenu', noMenu);
    return () => { el.removeEventListener('touchmove', still); el.removeEventListener('contextmenu', noMenu); };
  }, []);

  /** What a grip needs to start a drag of `item` out of the box called `from`. */
  const grip = (item, from) => ({ onPointerDown: (e) => start(e, item, from) });
  /** What a row needs to be picked up by itself (see `pressed`). The browser's own dragging of its picture is turned off. */
  const press = (item, from) => ({ onPointerDown: (e) => pressed(e, item, from), onDragStart: (e) => e.preventDefault() });
  return { drag, grip, press, touchArea, ghost };
}

// A mouse picks a row up once it has moved this many pixels with the button held; less than that is a click.
const MOUSE_START = 5;
// A finger picks a row up once it has been held this long without moving more than FINGER_SLIP pixels. Moving
// further first is scrolling the page, and the row is left alone. Long enough not to catch a finger that stops
// for a moment while scrolling, and short enough not to feel like waiting.
const HOLD = 400;
const FINGER_SLIP = 10;

/** The boxes around an element that scroll up and down by themselves, the nearest first. */
function scrollingBoxes(el) {
  const boxes = [];
  for (let at = el.parentElement; at && at !== document.body; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === 'auto' || overflowY === 'scroll') boxes.push(at);
  }
  return boxes;
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

/**
 * The gap that opens where the dragged row would land: as tall as the row, within reason. With `fill` it covers the
 * whole of its list instead, for a list with nothing on it, so that the list is no taller or shorter for it.
 */
export function DropSlot({ height, fill, children }) {
  return (
    <li aria-hidden="true" data-drop-slot="" style={fill ? undefined : { height: Math.max(40, Math.min(height || 0, 96)) }}
      className={cx('flex items-center justify-center rounded-lg border-2 border-dashed border-brand-400 bg-brand-50 text-[13px] font-medium text-brand-700', fill && 'absolute inset-1.5')}>
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

/**
 * Keep an element where it was on screen (its top was `top`) after the page around it has changed size, by
 * scrolling whatever it is in: the box nearest it first, then the page. Used when the places to drop on open up
 * as a drag starts, and close again when it ends, so that what is under the pointer stays under it.
 */
export function keepInPlace(el, top) {
  let off = el.getBoundingClientRect().top - top;
  for (const box of scrollingBoxes(el)) {
    if (Math.abs(off) < 1) return;
    const before = box.scrollTop;
    box.scrollTop += off;
    off -= box.scrollTop - before;
  }
}
