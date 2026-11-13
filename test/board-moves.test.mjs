// Dragging people between the stages of a job's pipeline in the dropdown under its card on the job board, without a
// browser or a port: what is under the pointer, whether letting go there is a move, what the dropdown shows while a
// move is on its way and after it, Undo, and the words of the message. The page (src/components/JobBoard.jsx) and the
// dragging (src/components/DragDrop.jsx) are read too, to see that they use these and nothing of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inBox, nudgeFor, zoneAt } from '../src/drag-zones.js';
import { SHOWN, dropToStage, movedWords, notMovedWords, placeOf, readZone, showMoves, stageZone, stillToShow, undoOf, wordsAfter } from '../src/board-moves.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// A made-up job 7 and its stages, as GET /jobs/:id/pipeline sends them.
const person = (id, name, status = 'active') => ({ id, name, status, candidate_id: id + 100, photo: null, current_title: null, current_company: null });
const pipeline = () => [
  { id: 1, name: 'Applied', kind: 'applied', count: 2, people: [person(12, 'Ada Lane'), person(11, 'Ben Okoro')] },
  { id: 2, name: 'Recruiter screen', kind: 'interview', count: 1, people: [person(10, 'Tom Kaplan')] },
  { id: 3, name: 'Final Round', kind: 'interview', count: 0, people: [] },
  { id: 4, name: 'Offer', kind: 'offer', count: 0, people: [] },
  { id: 5, name: 'Hired', kind: 'hired', count: 1, people: [person(9, 'Cleo Park', 'hired')] },
];
const counts = (stages) => stages.map((s) => s.count);
const names = (stages, stageId) => stages.find((s) => s.id === stageId).people.map((p) => p.name);
const tom = { ...person(10, 'Tom Kaplan'), jobId: 7, stageId: 2 };
const box = (left, top, right, bottom) => ({ left, top, right, bottom });

test('the zone under the pointer: the first that holds the point, can be seen inside what it scrolls in, and takes the drop', () => {
  assert.equal(inBox(box(0, 0, 10, 10), 10, 0), true);
  assert.equal(inBox(box(0, 0, 10, 10), 11, 5), false);
  const column = box(0, 100, 200, 400); // a column that scrolls inside itself
  const zones = [
    { name: 'stage:7:1', box: box(0, 40, 200, 90), clips: [column] },   // scrolled up out of the column, under its heading
    { name: 'stage:7:2', box: box(0, 100, 200, 160), clips: [column] },
    { name: 'stage:7:3', box: box(0, 160, 200, 190), clips: [column] },
    { name: 'stage:7:4', box: box(0, 380, 200, 460), clips: [column] }, // half below the column's bottom edge
  ];
  assert.equal(zoneAt(zones, 50, 120), 'stage:7:2');
  assert.equal(zoneAt(zones, 50, 160), 'stage:7:2', 'an edge shared by two stages belongs to the first');
  assert.equal(zoneAt(zones, 50, 175), 'stage:7:3');
  assert.equal(zoneAt(zones, 50, 60), null, 'a stage scrolled out of sight does not take the drop');
  assert.equal(zoneAt(zones, 50, 390), 'stage:7:4', 'the part of a stage that can be seen takes it');
  assert.equal(zoneAt(zones, 50, 430), null, 'the part that cannot does not');
  assert.equal(zoneAt(zones, 300, 120), null, 'off to the side of every stage');
  assert.equal(zoneAt(zones, 50, 120, (name) => name !== 'stage:7:2'), null, 'a zone that does not take this drop is passed over');
  assert.equal(zoneAt([{ name: 'job', box: box(0, 0, 10, 10) }], 5, 5), 'job', 'a zone with nothing around it that scrolls');
});

test('held near an edge: the page scrolls at one speed, a column that scrolls inside itself faster the nearer its edge, and only under the pointer', () => {
  const page = box(0, 60, 1280, 800);
  assert.equal(nudgeFor(page, 500, 400), 0);
  assert.equal(nudgeFor(page, 500, 70), -12);
  assert.equal(nudgeFor(page, 500, 790), 12);
  assert.equal(nudgeFor(page, 5000, 790), 12, 'the page scrolls wherever the pointer is across it');
  const column = box(300, 200, 520, 700);
  const inner = { inner: true, edge: 44 };
  assert.equal(nudgeFor(column, 400, 450, inner), 0);
  assert.equal(nudgeFor(column, 400, 699, inner), 12, 'right at the bottom edge: full speed');
  assert.ok(nudgeFor(column, 400, 660, inner) > 0 && nudgeFor(column, 400, 660, inner) < 4, 'just inside the edge: slowly');
  assert.ok(nudgeFor(column, 400, 205, inner) < -8, 'near the top edge: up');
  assert.equal(nudgeFor(column, 400, 720, inner), 12, 'just below the column still scrolls it');
  assert.equal(nudgeFor(column, 600, 699, inner), 0, 'over another column: not this one');
  assert.equal(nudgeFor(column, 400, 800, inner), 0, 'far below it: not this one');
});

test('what a drop means: a stage of the same job other than their own is a move; anything else is nothing', () => {
  assert.equal(stageZone(7, 3), 'stage:7:3');
  assert.deepEqual(readZone('stage:7:3'), { jobId: 7, stageId: 3 });
  assert.equal(readZone('job'), null);
  assert.equal(readZone(null), null);
  assert.equal(dropToStage(tom, 'stage:7:3'), 3, 'another stage of his job');
  assert.equal(dropToStage(tom, 'stage:7:5'), 5, 'Hired too');
  assert.equal(dropToStage(tom, 'stage:7:2'), null, 'the stage he is in');
  assert.equal(dropToStage(tom, 'stage:8:3'), null, 'a stage of another job');
  assert.equal(dropToStage(tom, 'pick-jobs'), null, 'something that is not a stage');
  assert.equal(dropToStage(tom, null), null, 'nothing at all');
});

test('a move shows at once: the person is in their new stage, in the server’s order, and the counts follow', () => {
  const stages = pipeline();
  const moved = showMoves(stages, [{ person: tom, from: 2, to: 1 }]);
  assert.deepEqual(counts(moved), [3, 0, 0, 0, 1]);
  assert.deepEqual(names(moved, 1), ['Ada Lane', 'Ben Okoro', 'Tom Kaplan'], 'newest application first, as the server lists them');
  assert.deepEqual(names(moved, 2), []);
  assert.deepEqual(counts(stages), [2, 1, 0, 0, 1], 'what the server said is left as it was');
  // Into an empty stage, and into Hired, which marks them hired; out of Hired, in play again.
  assert.deepEqual(names(showMoves(stages, [{ person: tom, from: 2, to: 3 }]), 3), ['Tom Kaplan']);
  const hired = showMoves(stages, [{ person: tom, from: 2, to: 5 }]);
  assert.deepEqual(hired.find((s) => s.id === 5).people.map((p) => [p.name, p.status]), [['Tom Kaplan', 'hired'], ['Cleo Park', 'hired']]);
  const cleo = { ...person(9, 'Cleo Park', 'hired'), jobId: 7, stageId: 5 };
  assert.deepEqual(showMoves(stages, [{ person: cleo, from: 5, to: 4 }]).find((s) => s.id === 4).people.map((p) => p.status), ['active']);
  // What the dropdown draws for a person comes from the server's answer, not from what was dragged.
  const dragged = { ...tom, stages: [], stageName: 'Recruiter screen' };
  assert.equal(showMoves(stages, [{ person: dragged, from: 2, to: 3 }]).find((s) => s.id === 3).people[0].candidate_id, 110);
});

test('two quick moves of one person end where the second put them, and a fresh answer that has them there already is left alone', () => {
  const stages = pipeline();
  const moves = [{ person: tom, from: 2, to: 3 }, { person: { ...tom, stageId: 3 }, from: 3, to: 4 }];
  const shown = showMoves(stages, moves);
  assert.deepEqual(counts(shown), [2, 0, 0, 1, 1]);
  assert.deepEqual(names(shown, 4), ['Tom Kaplan']);
  // The server's answer to the first move arrives while the second is on its way: he is in Final Round there.
  const first = showMoves(stages, moves.slice(0, 1));
  assert.deepEqual(counts(showMoves(first, moves)), [2, 0, 0, 1, 1]);
  // Both saved and the answer has him in Offer: laying the moves over it changes nothing.
  assert.deepEqual(showMoves(shown, moves), shown);
  // Somebody else took him off the job meanwhile: he is nowhere, and nothing is made up.
  const gone = stages.map((s) => (s.id === 2 ? { ...s, count: 0, people: [] } : s));
  assert.deepEqual(counts(showMoves(gone, moves)), [2, 0, 0, 0, 1]);
  // A stage that is no longer there.
  assert.deepEqual(counts(showMoves(stages, [{ person: tom, from: 2, to: 99 }])), counts(stages));
});

test('a long stage: somebody moved into it can go under “and N more”, and the message says where they went', () => {
  const many = Array.from({ length: SHOWN }, (_, i) => person(50 + i, `Person ${50 + i}`)).reverse(); // newest first
  const stages = pipeline().map((s) => (s.id === 1 ? { ...s, count: 11, people: many } : s));
  // Newer than everyone named: named first, and the last one named goes under "and N more".
  const newer = { ...person(70, 'Nia Brook'), jobId: 7, stageId: 2 };
  const top = showMoves(stages.map((s) => (s.id === 2 ? { ...s, people: [newer] } : s)), [{ person: newer, from: 2, to: 1 }]);
  assert.equal(top[0].count, 12);
  assert.equal(top[0].people.length, SHOWN);
  assert.equal(top[0].people[0].name, 'Nia Brook');
  assert.equal(placeOf(top, newer).stage.id, 1);
  // Older than everyone named: counted, and among the rest.
  const under = showMoves(stages, [{ person: tom, from: 2, to: 1 }]);
  assert.equal(under[0].count, 12);
  assert.equal(under[0].people.length, SHOWN);
  assert.equal(placeOf(under, tom), null);
  const move = { person: tom, from: 2, to: 1 };
  assert.equal(wordsAfter(under, move), 'Moved Tom Kaplan to Applied, under “and 4 more”');
  // A stage that names everybody, full to SHOWN: he is named, and the last one goes under "and 1 more".
  const full = pipeline().map((s) => (s.id === 1 ? { ...s, count: SHOWN, people: many } : s));
  const fuller = showMoves(full, [move]);
  assert.equal(fuller[0].count, SHOWN + 1);
  assert.equal(fuller[0].people.length, SHOWN);
  assert.equal(wordsAfter(fuller, move), 'Moved Tom Kaplan to Applied, under “and 1 more”', 'the oldest application is the one not named');
  // Moved out of a long stage: one fewer, and the server fills the gap when it answers.
  const nia = { ...many[0], jobId: 7, stageId: 1 };
  const out = showMoves(stages, [{ person: nia, from: 1, to: 3 }]);
  assert.deepEqual([out[0].count, out[0].people.length, out[2].count], [10, SHOWN - 1, 1]);
  // Moved again while under "and N more" of the stage they were put in: taken from that stage's count.
  const again = showMoves(under, [{ person: { ...tom, stageId: 1 }, from: 1, to: 4 }]);
  assert.deepEqual([again[0].count, again[3].count, names(again, 4)], [11, 1, ['Tom Kaplan']]);
});

test('a move is laid over the server’s answers until one asked for after it was saved arrives', () => {
  const unsaved = { key: 'a', saved: null };
  const saved = { key: 'b', saved: 5 };
  assert.deepEqual(stillToShow([unsaved, saved], 4), [unsaved, saved], 'an answer asked for before the move was saved');
  assert.deepEqual(stillToShow([unsaved, saved], 5), [unsaved, saved], 'asked at the same moment: not known to be after');
  assert.deepEqual(stillToShow([unsaved, saved], 6), [unsaved], 'asked after: the server has it, and it is shown as the server says');
});

test('Undo moves them back to the stage they came from, and its own message says “back”', () => {
  const move = { person: tom, from: 2, to: 5 };
  const back = undoOf(move);
  assert.deepEqual([back.from, back.to, back.undo, back.person.stageId, back.person.id], [5, 2, true, 5, 10]);
  const hired = showMoves(pipeline(), [move]);
  assert.equal(wordsAfter(hired, move), 'Marked Tom Kaplan as hired');
  const undone = showMoves(hired, [back]);
  assert.deepEqual(counts(undone), counts(pipeline()));
  assert.equal(wordsAfter(undone, back), 'Moved Tom Kaplan back to Recruiter screen');
  // Undo out of Hired into another stage is a move back, not a hire.
  assert.equal(movedWords('Tom Kaplan', { name: 'Hired', kind: 'hired' }, { undo: true }), 'Moved Tom Kaplan back to Hired');
  assert.equal(movedWords('Tom Kaplan', { name: 'Final Round', kind: 'interview' }), 'Moved Tom Kaplan to Final Round');
  assert.equal(wordsAfter(pipeline(), { person: tom, from: 2, to: 99 }), 'Moved Tom Kaplan to another stage');
});

test('when The Book refuses a move, the message says who was not moved and why, in plain words', () => {
  assert.equal(notMovedWords('Tom Kaplan', new Error('That stage does not belong to this job.')), 'Tom Kaplan was not moved: That stage does not belong to this job.');
  assert.equal(notMovedWords('Tom Kaplan', new TypeError('Failed to fetch')), 'Tom Kaplan was not moved: The Book could not be reached. Check your connection and try again.');
});

test('the board uses these rules, and shows only as many people per stage as the server sends', () => {
  const board = read('src/components/JobBoard.jsx');
  for (const name of ['dropToStage', 'showMoves', 'stillToShow', 'undoOf', 'wordsAfter', 'stageZone', 'readZone']) assert.match(board, new RegExp(`\\b${name}\\(`), name);
  assert.match(read('src/components/DragDrop.jsx'), /zoneAt\(/);
  assert.match(read('src/components/DragDrop.jsx'), /nudgeFor\(/);
  assert.match(read('server/api.js'), new RegExp(`const BOARD_PEOPLE = ${SHOWN};`));
  // The move is the Pipeline tab's own: no new route.
  assert.match(board, /api\.post\(`\/applications\/\$\{id\}\/move`, \{ stage_id: to\.id \}\)/);
});
