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
 * Text as it can be printed: control and invisible characters out, Word's bullets as bullets, tabs as spaces, and
 * anything neither font can draw left out. `dropped` says whether something was left out.
 */
export function printable(input) {
  let dropped = false;
  const out = String(input ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(WORD_BULLETS, '•').replace(/\t/g, '    ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/[^\n]/gu, (ch) => {
      if (ch === ' ' || COVER.body.hasGlyphForCodePoint(ch.codePointAt(0))) return ch;
      if (!RIGHT_TO_LEFT.test(ch) && !/\p{Co}/u.test(ch) && COVER.fallback.hasGlyphForCodePoint(ch.codePointAt(0))) return ch;
      dropped = true;
      return '';
    });
  return { text: out, dropped };
}

// A line that starts a list item: a bullet of any kind, a dash or star with a space after it, or a number.
const BULLET = /^(\s*)(?:([•●▪■◦‣⁃∙·☐☑✓✔➢➤►▸→])\s*|([*–—-])\s+|(\(?\d{1,2}[.)])\s+|(o)\s+(?=\S))/u;
const SECOND_LEVEL = new Set(['◦', '‣', '⁃', 'o', '▸']);

/**
 * The advert cut into blocks to lay out: headings, list items, lines of a paragraph, and gaps where a blank line was.
 * A heading is a short line standing on its own, as adverts are written ("What you will do", "About the role:"): no
 * more than eight words, not ending as a sentence does, starting with a capital, after a blank line (or ending with
 * a colon), and with something after it.
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
      if (rest) blocks.push({ kind: 'item', marker: m[4] ? m[4] : level ? '◦' : '•', level, text: rest });
      return;
    }
    const prev = i > 0 ? lines[i - 1].trim() : '';
    const later = lines.slice(i + 1).some((l) => l.trim());
    const short = t.length <= 70 && t.split(/\s+/).length <= 8;
    const heading = short && later && !/[.,;!?…]$/.test(t) && /^[\p{Lu}\p{N}]/u.test(t) && (!prev || t.endsWith(':'));
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

  /**
   * Write text in one style, at x and across width, wrapping as it goes. A character the main font lacks is written
   * in the fallback font, as a run of its own inside the same line.
   */
  function write(raw, { font = 'body', size = SIZE.body, color = INK, x = left, w = width, y, gap = GAP, characterSpacing = 0, align = 'left' } = {}) {
    const text = printable(raw).text.replace(/ {2,}/g, ' ');
    if (!text.trim()) return;
    const runs = [];
    for (const ch of text) {
      const own = ch === ' ' || COVER[font].hasGlyphForCodePoint(ch.codePointAt(0)) ? font : 'fallback';
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
  const body = lineHeight(SIZE.body);
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
      const y = pdf.y;
      write(block.marker, { x: markerX, y, w: indent, color: block.marker.length > 1 ? INK : ACCENT });
      pdf.y = y;
      write(block.text, { x: left + indent + (block.marker.length > 1 ? 6 : 0), y, w: width - indent - (block.marker.length > 1 ? 6 : 0) });
      pdf.y += 2.5;
    } else {
      roomFor(body);
      write(block.text);
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
