// What is under the pointer while something is dragged, worked out from boxes alone (no page, no React), so that the
// rules can be tested without a browser. src/components/DragDrop.jsx measures the page and asks these.

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
