// A job description as a PDF: the job's heading and its advert, laid out on A4 for a candidate to read or print.
// It is made from text only (the advert is plain text with line breaks, as the job form and the careers page have
// it), so nothing here knows about clients or confidentiality: jobdescription.js decides what goes in.
//
// The fonts are in server/fonts, so nothing is fetched while a document is made: Inter for the text (the app's own
// typeface) and DejaVu Sans for the characters Inter does not have (tick boxes, some arrows and symbols). Whatever
// neither has (emoji, Chinese, Japanese and Korean, right-to-left scripts, which would come out in the wrong order)
// is left out rather than printed as empty boxes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import * as fontkit from 'fontkit';

const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
const FILES = { body: 'Inter-Regular.otf', bold: 'Inter-SemiBold.otf', fallback: 'DejaVuSans.ttf' };
const BYTES = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(path.join(FONTS, file))]));
// Read once, only to ask which characters each font has.
const COVER = { body: fontkit.create(BYTES.body), bold: fontkit.create(BYTES.bold), fallback: fontkit.create(BYTES.fallback) };

/** The longest advert that is laid out: the job form's own limit. A longer one (only possible by editing the database) is cut there. */
export const MAX_TEXT = 20000;

// Scripts written right to left. DejaVu has some of their letters, but the PDF would set them left to right.
const RIGHT_TO_LEFT = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}]/u;
// Word's own bullets, which arrive as characters from its private area when a list is pasted from it.
const WORD_BULLETS = /[\uF0B7\uF0A7\uF0D8\uF076\uF0FC\uF0A8\uF0D9\uF06C\uF06E]/g;

/**
 * Text as it can be printed: control and invisible characters out, Word's bullets as bullets, and anything neither
 * font can draw left out. `dropped` says whether something was left out.
 *
 * What comes out is exactly what is printed, character for character, so the check for the PDF without the client's
 * name (jobdescription.js) is run on the very words in the file. So spaces and tabs inside a line become one space
 * here and nowhere later ("L\tu\tm\te\tn" is checked as it prints, "L u m e n"); only the spaces a line starts with
 * are kept, a tab as four, because they say how far a list item is indented. Private-use characters are all left out,
 * whatever the font has for them: Inter draws some as other forms of ordinary letters, so a name could be spelt with
 * them and print as the name while the check reads something else. Where a word in a script neither font has was
 * left out, the brackets around it and the space before it go too, so "Japan (日本) and" reads "Japan and".
 */
export function printable(input) {
  let dropped = false;
  const GONE = '\u0000'; // marks what was left out, until it is tidied away (control characters are spaces by then)
  let out = String(input ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(WORD_BULLETS, '•')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/[^\n\t]/gu, (ch) => {
      const code = ch.codePointAt(0);
      if (!/\p{Co}/u.test(ch)) {
        if (ch === ' ' || COVER.body.hasGlyphForCodePoint(code)) return ch;
        if (!RIGHT_TO_LEFT.test(ch) && COVER.fallback.hasGlyphForCodePoint(code)) return ch;
      }
      dropped = true;
      return GONE;
    });
  if (dropped) {
    out = out.replace(/[ \t]*[([{]([ \t\u0000]*\u0000[ \t\u0000]*)[)\]}]/g, '') // brackets with nothing left in them
      .replace(/[ \t]+[ \t\u0000]*\u0000[ \t\u0000]*(?=[.,;:!?]|$)/gm, '') // the space before what went, at a stop or the end of a line
      .replace(/\u0000/g, '');
  }
  out = out.split('\n').map((line) => {
    const lead = /^[ \t]*/.exec(line)[0];
    return lead.replace(/\t/g, '    ') + line.slice(lead.length).replace(/[ \t]+/g, ' ');
  }).join('\n');
  return { text: out, dropped };
}

/**
 * A word too long for a line (a long link, a pasted separator) can only be broken one character at a time, and
 * pdfkit's way of doing that takes time that grows with the square of the word's length: a 20,000-character word
 * held the server for half a minute. So a run of more than 40 characters with no space gets a zero-width space every
 * 10, where the line may break; it is not seen on the page and the words around it are untouched. Done only as the
 * text is laid out, after the check has seen it, and invisible, so the check and the page still read the same.
 */
const breakable = (text, tooWide) => text.replace(/\S{41,}/gu, (word) => (tooWide(word) ? word.match(/[\s\S]{1,10}/gu).join('\u200b') : word));

// A line that starts a list item: a bullet of any kind, a dash or star with a space after it, or a number.
const BULLET = /^(\s*)(?:([•●▪■◦‣⁃∙·☐☑✓✔➢➤►▸→])\s*|([*–—-])\s+|(\(?\d{1,2}[.)])\s+|(o)\s+(?=\S))/u;
const SECOND_LEVEL = new Set(['◦', '‣', '⁃', 'o', '▸']);
// Tick boxes keep their own mark, as numbers do: ticked and not ticked mean different things.
const TICKS = new Set(['☐', '☑', '✓', '✔']);

/**
 * The advert cut into blocks to lay out: headings, list items, lines of a paragraph, and gaps where a blank line was.
 * A heading is a short line standing on its own, as adverts are written ("What you will do", "About the role:"): no
 * more than eight words, not ending as a sentence does, starting with a capital, after a blank line (or ending with
 * a colon), and with something after it. A line with a colon in the middle, a currency sign or ending in a figure is
 * a fact ("Salary: £50,000", "Hours 9 to 5"), not a heading.
 */
export function blocksOf(text) {
  const lines = text.split('\n');
  const blocks = [];
  const bulletAt = (i) => i >= 0 && i < lines.length && BULLET.test(lines[i]) && !/^\s*o\s/.test(lines[i]);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) { if (blocks.length && blocks.at(-1).kind !== 'gap') blocks.push({ kind: 'gap' }); return; }
    const m = BULLET.exec(line);
    // "o " only counts as Word's second-level bullet beside other list items.
    if (m && (!m[5] || bulletAt(i - 1) || bulletAt(i + 1))) {
      const symbol = m[2] || m[3] || m[5];
      const level = m[1].replace(/\t/g, '    ').length >= 2 || SECOND_LEVEL.has(symbol) ? 1 : 0;
      const rest = line.slice(m[0].length).trim();
      if (rest) blocks.push({ kind: 'item', marker: m[4] ? m[4] : TICKS.has(symbol) ? symbol : level ? '◦' : '•', level, text: rest });
      return;
    }
    const prev = i > 0 ? lines[i - 1].trim() : '';
    const later = lines.slice(i + 1).some((l) => l.trim());
    const short = t.length <= 70 && t.split(/\s+/).length <= 8;
    const fact = /:\s*\S/.test(t) || /\p{Sc}/u.test(t) || /\d$/.test(t);
    const heading = short && later && !fact && !/[.,;!?…]$/.test(t) && /^[\p{Lu}\p{N}]/u.test(t) && (!prev || t.endsWith(':'));
    blocks.push({ kind: heading ? 'heading' : 'line', text: t });
  });
  while (blocks.length && blocks.at(-1).kind === 'gap') blocks.pop();
  return blocks;
}

const INK = '#1c1917', SOFT = '#57534e', FAINT = '#78716c', ACCENT = '#0c505d', RULE = '#d6d3d1';
const SIZE = { body: 10.5, heading: 12, title: 22, client: 13, facts: 10, agency: 8.5, footer: 8 };
const GAP = 3; // between lines of text

/**
 * The PDF, as a Buffer. `doc` is { agency, title, subtitle, facts: [..], note, description, date, info: { Title,
 * Author, Subject } }. Everything in it is printed as given; nothing else is added but the page numbers.
 */
export function makePdf(input) {
  const pdf = new PDFDocument({
    size: 'A4', margins: { top: 58, bottom: 70, left: 64, right: 64 }, bufferPages: true, autoFirstPage: true,
    info: { ...input.info, Creator: 'The Book', Producer: 'The Book' }, lang: 'en-GB', displayTitle: true,
  });
  pdf.registerFont('body', BYTES.body);
  pdf.registerFont('bold', BYTES.bold);
  pdf.registerFont('fallback', BYTES.fallback);
  const chunks = [];
  pdf.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });

  const left = pdf.page.margins.left;
  const width = pdf.page.width - left - pdf.page.margins.right;
  const bottom = () => pdf.page.height - pdf.page.margins.bottom;
  const lineHeight = (size) => size * 1.21 + GAP;
  const body = lineHeight(SIZE.body);

  /**
   * Write text in one style, at x and across width, wrapping as it goes. A character the main font lacks is written
   * in the fallback font, as a run of its own inside the same line.
   */
  function write(raw, { font = 'body', size = SIZE.body, color = INK, x = left, w = width, y, gap = GAP, characterSpacing = 0, align = 'left' } = {}) {
    // Only a run too wide for its line is given break points: a link that fits is left whole, so that it can be
    // copied out of the PDF as it was written (some viewers copy a break point as a space).
    pdf.font(font).fontSize(size);
    const text = breakable(printable(raw).text.trim(), (word) => word.length > 400 || pdf.widthOfString(word, { characterSpacing }) > w * 0.95);
    if (!text) return;
    const runs = [];
    for (const ch of text) {
      const own = ch === ' ' || ch === '\u200b' || COVER[font].hasGlyphForCodePoint(ch.codePointAt(0)) ? font : 'fallback';
      if (runs.length && runs.at(-1).font === own) runs.at(-1).text += ch; else runs.push({ font: own, text: ch });
    }
    pdf.fillColor(color);
    runs.forEach((run, i) => {
      pdf.font(run.font).fontSize(size);
      const opts = { lineGap: gap, characterSpacing, continued: i < runs.length - 1, align };
      if (i === 0) pdf.text(run.text, x, y ?? pdf.y, { ...opts, width: w });
      else pdf.text(run.text, opts);
    });
    pdf.x = left;
  }
  /** Start a new page unless `room` points fit on this one. */
  const roomFor = (room) => { if (pdf.y + room > bottom()) pdf.addPage(); };
  /**
   * Write a paragraph or list item so that a page break never leaves a single line of it on its own, at the foot of a
   * page or at the top of the next. When only its last line would go over, the page ends a line early and two go
   * over; when only one line would fit, all of it goes to the next page. It is measured only near the foot of a page,
   * where it could matter: measuring every block would double the work.
   */
  const keepLines = (text, w, draw) => {
    const room = bottom() - pdf.y;
    // More lines than it can take: a character is narrower than its type size, and wrapping wastes less than half a line.
    const most = Math.ceil((text.length * SIZE.body * 1.5) / w) + 1;
    if (most * body <= room) return draw();
    pdf.font('body').fontSize(SIZE.body);
    // As pdfkit counts: a line fits while its own height does, and each line after the first is a gap further down.
    const own = pdf.currentLineHeight(true), step = own + GAP;
    const lines = Math.round(pdf.heightOfString(breakable(printable(text).text.trim(), (word) => word.length > 400 || pdf.widthOfString(word) > w * 0.95), { width: w, lineGap: GAP }) / step);
    const fit = room < own ? 0 : Math.floor((room - own) / step) + 1;
    if (lines <= fit) return draw();
    if (fit < 2 || (lines - fit < 2 && fit < 3)) { pdf.addPage(); return draw(); }
    if (lines - fit >= 2) return draw();
    const page = pdf.page;
    page.margins.bottom += step;
    try { return draw(); } finally { page.margins.bottom -= step; }
  };

  // ----- the heading -----
  write(input.agency.toUpperCase(), { font: 'bold', size: SIZE.agency, color: ACCENT, characterSpacing: 0.8 });
  pdf.moveDown(0.9);
  write(input.title, { font: 'bold', size: SIZE.title, gap: 2 });
  if (input.subtitle) { pdf.moveDown(0.15); write(input.subtitle, { size: SIZE.client, color: SOFT }); }
  if (input.facts?.length) { pdf.moveDown(0.35); write(input.facts.join('  ·  '), { size: SIZE.facts, color: SOFT }); }
  if (input.note) { pdf.moveDown(0.35); write(input.note, { size: SIZE.facts - 0.5, color: FAINT }); }
  pdf.moveDown(0.9);
  pdf.moveTo(left, pdf.y).lineTo(left + width, pdf.y).lineWidth(0.6).strokeColor(RULE).stroke();
  pdf.moveDown(1.1);

  // ----- the advert -----
  const blocks = blocksOf(printable(String(input.description ?? '').slice(0, MAX_TEXT)).text);
  let previous = null;
  for (const block of blocks) {
    if (block.kind === 'gap') { pdf.y += body * 0.6; previous = block; continue; }
    if (block.kind === 'heading') {
      // A heading is never left alone at the foot of a page: it and the first two lines under it go together.
      if (previous && previous.kind !== 'gap') pdf.y += body * 0.45;
      roomFor(lineHeight(SIZE.heading) + body * 2 + 4);
      write(block.text.replace(/:$/, ''), { font: 'bold', size: SIZE.heading });
      pdf.y += 3;
    } else if (block.kind === 'item') {
      roomFor(body);
      const indent = 15 + block.level * 16;
      const markerX = left + block.level * 16 + (block.marker.length > 1 ? 0 : 3);
      const w = width - indent - (block.marker.length > 1 ? 6 : 0);
      keepLines(block.text, w, () => {
        const y = pdf.y;
        write(block.marker, { x: markerX, y, w: indent, color: block.marker.length > 1 ? INK : ACCENT });
        pdf.y = y;
        write(block.text, { x: left + indent + (block.marker.length > 1 ? 6 : 0), y, w });
      });
      pdf.y += 2.5;
    } else {
      roomFor(body);
      keepLines(block.text, width, () => write(block.text));
    }
    previous = block;
  }

  // ----- the footer on every page: the agency, the day it was made, and page numbers when there is more than one -----
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    const keep = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0; // writing below the bottom margin must not start a new page
    const y = pdf.page.height - 42;
    pdf.moveTo(left, y - 9).lineTo(left + width, y - 9).lineWidth(0.5).strokeColor(RULE).stroke();
    write(`${input.agency}  ·  ${input.date}`, { size: SIZE.footer, color: FAINT, y, w: width * 0.7 });
    if (range.count > 1) write(`Page ${i - range.start + 1} of ${range.count}`, { size: SIZE.footer, color: FAINT, x: left + width * 0.7, y, w: width * 0.3, align: 'right' });
    pdf.page.margins.bottom = keep;
  }
  pdf.end();
  return done;
}
