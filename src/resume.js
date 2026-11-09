// Reads a résumé in the browser (the file never leaves the page until the candidate is saved) and guesses the
// contact details from its text. Email, phone and LinkedIn link are reliable; name, location, title and company are
// best guesses and the form always stays editable.

/** Plain text of a PDF, Word (.docx), RTF or text file. Returns '' for formats that cannot be read (e.g. old .doc). */
export async function extractResumeText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return pdfText(await file.arrayBuffer());
  if (name.endsWith('.docx')) return docxText(new Uint8Array(await file.arrayBuffer()));
  if (name.endsWith('.txt')) return file.text();
  if (name.endsWith('.rtf')) return rtfText(await file.text());
  return '';
}

async function pdfText(buffer) {
  const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: buffer, isEvalSupported: false, disableFontFace: true });
  const doc = await task.promise;
  const lines = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, 4); n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      let line = '', lastY = null;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const y = Math.round(item.transform[5]);
        if (lastY !== null && Math.abs(y - lastY) > 2 && line.trim()) { lines.push(line); line = ''; }
        line += (line && !line.endsWith(' ') && item.str && !item.str.startsWith(' ') && lastY === y ? ' ' : '') + item.str;
        lastY = y;
        if (item.hasEOL && line.trim()) { lines.push(line); line = ''; lastY = null; }
      }
      if (line.trim()) lines.push(line);
    }
  } finally {
    await task.destroy?.(); // frees the worker's copy of the file
  }
  return lines.join('\n');
}

async function docxText(bytes) {
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const xml = files['word/document.xml'];
  if (!xml) return '';
  return strFromU8(xml)
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>|<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

const rtfText = (rtf) =>
  rtf.replace(/\\par[d]?\b/g, '\n').replace(/\{\\\*[^{}]*\}/g, '').replace(/\\'[0-9a-f]{2}/gi, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');

// ---------- guessing the fields ----------
const TITLE_WORDS = /\b(engineer|developer|programmer|architect|manager|director|designer|analyst|scientist|consultant|specialist|coordinator|administrator|officer|executive|lead|head|chief|founder|president|vp|recruiter|accountant|controller|auditor|nurse|teacher|lecturer|researcher|technician|operator|supervisor|assistant|associate|advisor|adviser|strategist|planner|buyer|writer|editor|producer|marketer|representative|agent|partner|intern|apprentice|owner|sales|marketing|product|operations|finance|counsel|lawyer|solicitor|paralegal|surgeon|pharmacist|therapist|driver|chef)\b/i;
const NOT_A_NAME = /\b(curriculum|vitae|resume|résumé|cv|profile|summary|objective|contact|experience|education|skills|address|phone|email|page|linkedin|portfolio|references)\b/i;
const SECTION = /^(professional |work |career |relevant |employment )?(experience|employment|history|work history|career history|positions held)\b.{0,12}$/i;
const DATES = /\b((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(19|20)\d{2}\b.*$|\b(present|current|now|to date)\b.*$/i;
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const tidy = (s) => s.replace(DATES, '').replace(/[\s|•·,;:–—()[\]-]+$/g, '').replace(/^[\s|•·,;:–—()[\]-]+/g, '').trim();

/** @returns {{name?:string,email?:string,phone?:string,linkedin?:string,location?:string,current_title?:string,current_company?:string}} */
export function parseResume(text) {
  const out = {};
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return out;
  const head = lines.slice(0, 15);

  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/.exec(text);
  if (email) out.email = email[0].replace(/\.$/, '').toLowerCase();

  const link = /linkedin\.com\/(in|pub)\/[A-Za-z0-9\-_%.]+/i.exec(text);
  if (link) out.linkedin = `https://www.${link[0].replace(/\.$/, '')}`;

  for (const l of lines.slice(0, 25)) {
    const m = /(\(?\+?\d[\d ()./-]{7,}\d)/.exec(l);
    if (m && m[1].replace(/\D/g, '').length >= 9 && m[1].replace(/\D/g, '').length <= 15 && !/(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}/.test(m[1])) { out.phone = m[1].trim(); break; }
  }

  // Name: the first short line near the top made only of name-like words.
  for (const l of head.slice(0, 8)) {
    const candidate = l.split(/\s*[|•·]\s*/)[0].trim();
    const words = candidate.split(' ');
    if (words.length >= 2 && words.length <= 4 && /^[\p{L}][\p{L} .'’-]+$/u.test(candidate) && !NOT_A_NAME.test(candidate) && !TITLE_WORDS.test(candidate)) {
      out.name = candidate === candidate.toUpperCase() ? titleCase(candidate) : candidate;
      break;
    }
  }

  // Location: "City, Region" in the header block, or a labelled line.
  for (const l of head) {
    for (const part of l.split(/\s*[|•·]\s*/)) {
      const labelled = /^(location|address|based in)\s*[:\-–]\s*(.+)$/i.exec(part);
      if (labelled) { out.location = labelled[2].slice(0, 80); break; }
      if (/[@\d]|linkedin|github|http|www\./i.test(part) || part === out.name) continue;
      if (/^[\p{L}][\p{L} .'’-]{1,30},\s*[\p{L}][\p{L} .'’-]{1,30}(,\s*[\p{L}][\p{L} .'’-]{1,30})?$/u.test(part) && !TITLE_WORDS.test(part)) { out.location = part; break; }
    }
    if (out.location) break;
  }

  // Current role: the first entry under an "Experience" heading.
  const start = lines.findIndex((l) => SECTION.test(l));
  if (start >= 0) {
    const entry = lines.slice(start + 1, start + 5).map(tidy).filter((l) => l && l.length < 90);
    const [a, b] = entry;
    const split = a && /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(a) || a && /^(.+?)\s*[|–—]\s*(.+)$/.exec(a) || a && /^(.+?),\s+(.+)$/.exec(a);
    if (split) {
      const [x, y] = [tidy(split[1]), tidy(split[2])];
      if (TITLE_WORDS.test(x) || !TITLE_WORDS.test(y)) { out.current_title = x; out.current_company = y; } else { out.current_title = y; out.current_company = x; }
    } else if (a && b) {
      if (TITLE_WORDS.test(a) || !TITLE_WORDS.test(b)) { out.current_title = a; out.current_company = b; } else { out.current_title = b; out.current_company = a; }
    } else if (a && TITLE_WORDS.test(a)) out.current_title = a;
  }
  // Otherwise a headline under the name ("Senior Product Designer") is a fair guess at the title.
  if (!out.current_title && out.name) {
    const after = head.slice(head.findIndex((l) => l.includes(out.name) || l.toUpperCase().includes(out.name.toUpperCase())) + 1, 6).find((l) => TITLE_WORDS.test(l) && l.length < 70 && !/[@]|\d{5,}/.test(l));
    if (after) out.current_title = tidy(after.split(/\s*[|•·]\s*/)[0]);
  }
  for (const k of ['current_title', 'current_company']) if (out[k] && (out[k].length > 80 || out[k].length < 2)) delete out[k];
  return out;
}
