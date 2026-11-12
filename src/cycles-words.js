// The sentences the Cycles page uses about what it counts, kept apart from the page so that a test can read them
// without a browser (see test/cycles-words.test.mjs). Each one has to be true of what server/cycles.js does.
import { agoInWords } from './lib.js';

/**
 * The jobs the table leaves out, in the statuses The Book has (Open, Draft, Paused, Closed). Their cycles are kept
 * and count in the summary and By person.
 */
export const NOT_LISTED = 'Jobs that are closed, paused or still drafts are not listed here.';
export const WHICH_JOBS = 'Open jobs only. Cycles on jobs since closed, paused or set back to draft are kept, and count in the summary and By person.';

/**
 * Where the history starts. At the first start of the version with cycles, every job item already ticked became a
 * cycle if its to-do item still existed, whether it was still in Done or had been taken off it (or had run past the
 * seven days). Only a tick whose item was gone, because the person's account had been removed, could not be counted.
 */
export const historyNote = (day) =>
  `Cycles are counted from ${day}. Jobs ticked before then are counted too, even if they had since been taken off the Done list; only ticks by somebody whose account had already been removed could not be.`;

/**
 * "16 hours ago, by Priya Nair": the last cycle in words, for a screen reader, where the eye reads "16h ago". (The
 * column or the card already says "Last cycle"; a job with none says "Never" on the screen itself.)
 */
export const lastCycleWords = (at, by) => `${agoInWords(at)}, by ${by}`;
