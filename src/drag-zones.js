// What is under the pointer while something is dragged, worked out from boxes alone (no page, no React), so that the
// rules can be tested without a browser. src/components/DragDrop.jsx measures the page and asks these. Also when a box
// starts scrolling by itself, and the catching of the click a drag leaves behind, which need only times and events.

/** Is the point inside the box ({ left, top, right, bottom }), edges included? */
export const inBox = (box, x, y) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

/**
 * The first box the point is in that takes what is being dragged. Each zone is { name, box, clips }: `clips` are the
 * boxes it sits inside that scroll (a column on the job board, the page itself), and a zone only counts where it can
 * be seen inside all of them. A stage scrolled up out of its column still has a place on the page, under the column's
 * heading, and letting go there must not land in it. `accepts(name)` says whether this zone takes the drop.
 */
export function zoneAt(zones, x, y, accepts = () => true) {
  for (const zone of zones) {
    if (!inBox(zone.box, x, y)) continue;
    if ((zone.clips || []).some((clip) => !inBox(clip, x, y))) continue;
    if (!accepts(zone.name)) continue;
    return zone.name;
  }
  return null;
}

/**
 * How far to scroll a box this frame while something is held near its top or bottom edge: negative is up, 0 is not
 * at all. `edge` is how near counts, in pixels. The page itself scrolls at one speed whenever the pointer is near its
 * top or bottom. A box inside the page (a column that scrolls inside itself) is `inner`: the pointer must be over it
 * or just above or below it (a pointer off to the side, over another column, scrolls nothing here), and it scrolls
 * faster the nearer the edge the pointer is, so that a stage near the edge can still be dropped on without the column
 * running away under it.
 */
export function nudgeFor(box, x, y, { edge = 56, speed = 12, inner = false } = {}) {
  if (!inner) return y < box.top + edge ? -speed : y > box.bottom - edge ? speed : 0;
  if (x < box.left || x > box.right || y < box.top - edge || y > box.bottom + edge) return 0;
  const near = y < box.top + edge ? box.top + edge - y : y > box.bottom - edge ? y - (box.bottom - edge) : 0;
  if (!near) return 0;
  const by = Math.max(1, Math.round(speed * Math.min(1, near / edge)));
  return y < box.top + edge ? -by : by;
}

// How long the pointer must stay near an edge before a box scrolls by itself, when that is asked for. A person picked
// up near the foot of a column, or aimed at the last stage that can be seen there, would otherwise carry the column
// along at once, and the stage they meant would slide out from under the pointer before they let go.
export const EDGE_WAIT = 200;

/**
 * Hold back the scrolling `nudgeFor` asks for until the pointer has been near the edge for `wait` milliseconds.
 * `since` is when it came near (null when it is not near), and `now` the time of this frame. Gives back the speed to
 * scroll at now, and the `since` to pass in next frame.
 */
export function waitAtEdge(since, speed, now, wait = EDGE_WAIT) {
  if (!speed) return { since: null, speed: 0 };
  const from = since ?? now;
  return { since: from, speed: now - from >= wait ? speed : 0 };
}

/**
 * After a row has been dragged, the browser still sends a click when it is let go, to whatever is under the pointer
 * then (the row's own name, as often as not). That click is not passed on. A finger's click can come a little after
 * the finger is lifted, so the click within a short while of letting go is the one.
 *
 * Call it on `target` (the window) once the row has been picked up. It gives back `ended`, for the drag to call when it
 * stops for any reason. A drag does not always end with the button let go where the page can hear it: the window can
 * lose the focus in the middle of one, or the button can be let go over another window. Then no click is coming, and
 * nothing must be left waiting to eat the next one, wherever that is (Undo, say). So the catcher goes away a short
 * while after the drag ends, as it does after the button is let go, and at once when a new press begins, since a
 * click that follows a press of its own is not the drag's. Escape ends a drag with the button still held: `ended(false)`
 * then leaves the catcher waiting for the button to come up, as letting go over the name would otherwise open it.
 */
// Heard on the way down, before whatever is under the pointer. Written out in full: Node's own event targets, which
// the tests use, do not match a plain `true` when a listener is taken away.
const CAPTURE = { capture: true };
export function swallowClick(target, wait = 350) {
  let armed = false;
  let timer = null;
  const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); done(); };
  // A second finger coming down while the first still holds the row is not a new press of its own.
  const pressed = (ev) => { if (ev.isPrimary !== false) done(); };
  const done = () => {
    clearTimeout(timer);
    target.removeEventListener('click', swallow, CAPTURE);
    target.removeEventListener('pointerup', arm, CAPTURE);
    target.removeEventListener('pointercancel', arm, CAPTURE);
    target.removeEventListener('pointerdown', pressed, CAPTURE);
  };
  const arm = () => { if (armed) return; armed = true; timer = setTimeout(done, wait); };
  target.addEventListener('click', swallow, CAPTURE);
  target.addEventListener('pointerup', arm, CAPTURE);
  target.addEventListener('pointercancel', arm, CAPTURE);
  target.addEventListener('pointerdown', pressed, CAPTURE);
  return (released = true) => { if (released) arm(); };
}
