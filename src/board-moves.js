// Moving people between stages in a job's pipeline as it drops down under its card on the dashboard's job board
// (src/components/JobBoard.jsx). What a drop means, what the dropdown shows while a move is on its way to the server,
// and what the message after it says, as plain functions, so that they can be tested without a browser.

// The most people the server names under one stage of the dropdown (BOARD_PEOPLE in server/api.js); the rest are
// "and N more".
export const SHOWN = 8;

/** The name a stage goes by as a place to drop on. The job is part of it: a person can only go to a stage of their own job. */
export const stageZone = (jobId, stageId) => `stage:${jobId}:${stageId}`;
/** The job and stage a drop zone's name stands for, or null when it is not a stage. */
export function readZone(zone) {
  const m = /^stage:(\d+):(\d+)$/.exec(zone ?? '');
  return m ? { jobId: Number(m[1]), stageId: Number(m[2]) } : null;
}

/**
 * What letting go of a person over a zone means: the stage they go to, or null for nothing at all. Nothing is what
 * happens over the stage they are in already, over a stage of another job, and over anything that is not a stage.
 * `person` is { id, jobId, stageId }.
 */
export function dropToStage(person, zone) {
  const to = readZone(zone);
  if (!to || to.jobId !== person.jobId || to.stageId === person.stageId) return null;
  return to.stageId;
}

// The order the server lists the people in a stage: those who applied last first. The dropdown is not sent when
// people applied, so while a move is on its way the order their applications were made in stands in for it; the
// server's answer, asked for as soon as the move is saved, puts them in their true place, and the message after the
// move is worded from that answer.
const before = (a, b) => b.id - a.id;

/**
 * The stages as the dropdown shows them: what the server last said (`stages`, as GET /jobs/:id/pipeline sends
 * them), with the moves the server has not yet been asked about again laid over it. `moves` are { person, from, to }
 * in the order they were made; for somebody moved twice, the last one is where they are. Counts follow, and a person
 * moved into a stage that shows SHOWN people already may go under "and N more", as the server would put them.
 */
export function showMoves(stages, moves) {
  const last = new Map();
  for (const m of moves) last.set(m.person.id, m);
  const out = stages.map((s) => ({ ...s, people: [...s.people] }));
  for (const [id, m] of last) {
    const to = out.find((s) => s.id === m.to);
    if (!to) continue; // a stage that is no longer there: what the server says stands
    let person = m.person;
    const at = out.find((s) => s.people.some((p) => p.id === id));
    if (at === to) continue; // the server has them there already
    if (at) {
      person = at.people.find((p) => p.id === id); // as the server last sent them, which is newer than the move
      at.people = at.people.filter((p) => p.id !== id);
      at.count -= 1;
    } else {
      // Not named anywhere: they are under "and N more" of the stage they were moved from, or the server no longer
      // has them in the pipeline at all. Only a stage with people not named can be holding them.
      const from = out.find((s) => s.id === m.from);
      if (!from || from.count <= from.people.length) continue;
      from.count -= 1;
    }
    const placed = { ...person, status: to.kind === 'hired' ? 'hired' : 'active' };
    const hidden = to.count > to.people.length; // the stage has people the server did not name
    to.count += 1;
    const people = [...to.people, placed].sort(before);
    // Somebody who would come after the last one named, in a stage with more than are named, is among the rest.
    if (hidden && people.at(-1).id === id) continue;
    to.people = people.slice(0, SHOWN);
  }
  return out;
}

/** The stage somebody is named in, as { stage }, or null when they are named nowhere (under "and N more", or gone). */
export function placeOf(stages, person) {
  for (const stage of stages) if (stage.people.some((p) => p.id === person.id)) return { stage };
  return null;
}

/**
 * The moves still to lay over a fresh answer from the server. A move stays until the server has saved it and has
 * then been asked for the pipeline again: an answer to a question asked before that (one already on its way when the
 * person was dropped) may not have the move in it yet. `asked` is when the answer was asked for, and a move's
 * `saved` when the server saved it, both from the same counter; a move not yet saved has none.
 */
export const stillToShow = (moves, asked) => moves.filter((m) => m.saved == null || m.saved >= asked);

/** The move that puts somebody back where a move took them from: what Undo does. */
export const undoOf = (move) => ({ person: { ...move.person, stageId: move.to }, from: move.to, to: move.from, undo: true });

/**
 * The message after a move. A move to the stage of kind "hired" marks the person hired, and says so; Undo's own move
 * says "back". When they went under "and N more" of a long stage, it says so, since they are not named there.
 */
export function movedWords(name, stage, { undo = false, named = true } = {}) {
  const said = stage.kind === 'hired' && !undo ? `Marked ${name} as hired` : `Moved ${name}${undo ? ' back' : ''} to ${stage.name}`;
  return named ? said : `${said}, under “and ${stage.count - stage.people.length} more”`;
}

/**
 * The message for a move, from the stages as the server has them once it has saved it (or, failing an answer, as the
 * dropdown shows them). Somebody not named anywhere, moved into a stage with more people than are named, is under
 * its "and N more". Somebody the server has somewhere else (moved again by somebody else meanwhile) is still told as
 * the move that was made.
 */
export function wordsAfter(stages, move) {
  const to = stages.find((s) => s.id === move.to);
  if (!to) return movedWords(move.person.name, { name: 'another stage', kind: null }, { undo: move.undo });
  const named = Boolean(placeOf(stages, move.person)) || to.count <= to.people.length;
  return movedWords(move.person.name, to, { undo: move.undo, named });
}

/** Why a move was not made, for the message that says so. A request that never reached The Book fails with the browser's own words. */
export const notMovedWords = (name, err) => `${name} was not moved: ${err instanceof TypeError ? 'The Book could not be reached. Check your connection and try again.' : err?.message || 'something went wrong.'}`;
