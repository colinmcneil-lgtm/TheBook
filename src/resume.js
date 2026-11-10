// Reads a résumé in the browser (the file never leaves the page until the candidate is saved) and guesses the
// contact details from its text. Every field is either what the document supports or left empty: a wrong value
// filled in confidently costs more than a blank the recruiter types in, and the form always stays editable.

/** Plain text of a PDF, Word (.docx), RTF or text file. Returns '' for formats that cannot be read (e.g. old .doc). */
export async function extractResumeText(file) {
  return (await readFile(file)).text;
}

/**
 * The same for a long document (a job description, a call transcript): every page up to `maxPages`, with how
 * many pages the file has (`pages`) and how many were read (`read`) when it is a PDF, so the caller can say so.
 */
export async function extractDocumentText(file, maxPages = 300) {
  const { text, pages, read } = await readFile(file, maxPages);
  return { text, pages, read };
}

/**
 * What kind of file this is, from its first bytes before its name: a PDF or a Word file saved under a ".txt"
 * name is still a PDF or a Word file, and reading it as text would show (and parse) pages of binary.
 */
export function fileKind(bytes, name) {
  const head = String.fromCharCode(...bytes.subarray(0, 8));
  if (head.startsWith('%PDF-')) return 'pdf';
  if (head.startsWith('PK\u0003\u0004')) return 'docx';
  if (head.startsWith('{\\rtf')) return 'rtf';
  return /\.(pdf|docx|rtf|txt)$/i.exec(name)?.[1].toLowerCase() || '';
}

// A résumé is read as far as its first pages: the contact details and the current job are there.
const RESUME_PAGES = 4;

/** The text plus what the format can tell about its layout: per-line font sizes and link targets (PDF), page footers (Word). */
async function readFile(file, maxPages = RESUME_PAGES) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = fileKind(bytes, file.name);
  if (kind === 'pdf') return pdfText(bytes, maxPages);
  if (kind === 'docx') return docxText(bytes);
  if (kind !== 'txt' && kind !== 'rtf') return { text: '' };
  const text = decodeText(bytes);
  // Not text at all (a picture or another program's file under a text name): nothing to show or to read.
  const odd = text.match(/[\u0000-\u0008\u000e-\u001f�]/g)?.length || 0;
  if (text.includes('\u0000') || odd > text.length / 50) return { text: '', binary: true };
  return { text: kind === 'rtf' ? rtfText(text) : text };
}

/** Text files are not always UTF-8: Notepad saves UTF-16, and older exports use the Windows code page. */
function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}

// Headings set with wide letter spacing arrive as "H A N N A H"; put the words back together.
const SPACED_LETTERS = /^(?:\p{L} +){2,}\p{L}$/u;
const unspace = (s) => (SPACED_LETTERS.test(s) ? s.split(/ {2,}/).map((word) => word.replace(/ /g, '')).join(' ') : s);

async function pdfText(buffer, maxPages) {
  // The "legacy" build carries its own polyfills, so it also runs in browsers a year or two old.
  const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // The character maps are what turn text set in the standard Chinese, Japanese and Korean fonts back into letters.
  const task = pdfjs.getDocument({ data: buffer, isEvalSupported: false, disableFontFace: true, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/' });
  const doc = await task.promise;
  const lines = [], meta = [], links = [];
  const pages = doc.numPages, read = Math.min(pages, maxPages);
  try {
    for (let n = 1; n <= read; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // A PDF is a list of positioned text fragments: sometimes whole lines, sometimes single letters (résumés made
      // in design tools). Fragments are joined by where they sit: no gap means the same word, a small gap a new word,
      // a large gap a new column.
      let line = '', last = null, sizes = new Map();
      const flush = () => {
        if (line.trim()) {
          lines.push(line.trim());
          // The size most of the line is set in, so one oversized icon or initial does not speak for the whole line.
          meta.push({ size: [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] || 0, page: n });
        }
        line = ''; last = null; sizes = new Map();
      };
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const str = unspace(item.str);
        const x = item.transform[4], y = item.transform[5];
        const size = item.height || Math.abs(item.transform[3]) || 10;
        if (last && Math.abs(y - last.y) > size * 0.5) flush();
        const stretched = !str.trim() && (item.width || 0) > size * 2; // how the gap between two columns of a table arrives
        if (last && str) {
          const gap = x - (last.x + last.width);
          if (gap > size * 2 || gap < -size || stretched) line += ' · ';
          else if (gap > size * 0.18 && !line.endsWith(' ') && !str.startsWith(' ')) line += ' ';
        }
        if (!stretched) line += str;
        if (str) last = { x, y, width: item.width || 0 };
        if (str.trim() && item.height) { const h = Math.round(item.height * 2) / 2; sizes.set(h, (sizes.get(h) || 0) + str.trim().length); }
        if (item.hasEOL) flush();
      }
      flush();
      // A link keeps its whole address even when the visible text is wrapped, shortened or just says "LinkedIn".
      if (n <= 2) for (const a of await page.getAnnotations().catch(() => [])) if (typeof a.url === 'string' && LINKEDIN.test(a.url)) links.push(a.url);
    }
  } finally {
    await task.destroy?.(); // frees the worker's copy of the file
  }
  return { text: lines.join('\n'), layout: { lines: meta, links }, pages, read };
}

const xmlEntities = (s) => s.replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(+dec))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// No part of a real document comes near this unpacked; a few kilobytes of zip can claim to hold a gigabyte.
const MAX_PART = 8 * 1024 * 1024;

/**
 * The text of one part of a Word file. The XML is walked once, tag by tag: patterns that look for a closing tag
 * start again from every opening one, which a file made of unclosed tags turns into minutes of work.
 */
function wordXmlText(xml, targets) {
  let out = '', at = 0;
  let skip = null; // the closing tag that ends a part being left out
  let link = null; // an open hyperlink: where it goes, and where its text starts
  for (;;) {
    const lt = xml.indexOf('<', at), gt = lt < 0 ? -1 : xml.indexOf('>', lt);
    if (gt < 0) return skip ? out : out + xml.slice(at);
    if (!skip) out += xml.slice(at, lt);
    at = gt + 1;
    const name = /^\/?[\w:.-]*/.exec(xml.slice(lt + 1, lt + 40))[0], whole = xml[gt - 1] === '/'; // <w:tab/> has no closing tag
    if (skip) { if (name === skip) skip = null; continue; }
    // Text boxes are stored twice (once for older versions of Word); tab stop settings are not tab characters;
    // deleted text and field codes are not on the page.
    if (!whole && (name === 'mc:Fallback' || name === 'w:tabs' || name === 'w:delText' || name === 'w:instrText')) skip = `/${name}`;
    else if (name === 'w:numPr' && !whole) { skip = '/w:numPr'; out += '• '; } // list items carry no bullet character of their own
    else if (name === 'w:pStyle' && /w:val="List(?:Bullet|Number)/.test(xml.slice(lt, gt))) out += '• ';
    else if (name === 'w:tab' && whole) out += '\t';
    else if (((name === 'w:br' || name === 'w:cr') && whole) || name === '/w:p') out += '\n';
    else if (name === 'w:hyperlink' && !whole) {
      const id = /\br:id="([^"]*)"/.exec(xml.slice(lt, gt));
      link = id ? { target: targets.get(id[1]) || '', from: out.length } : null;
    } else if (name === '/w:hyperlink' && link) {
      // Where a link goes matters when the visible text is only "LinkedIn" or "Email".
      const shown = out.slice(link.from);
      if (LINKEDIN.test(link.target) && !/linkedin\.com\//i.test(shown)) out += ` ${link.target}`;
      else if (/^mailto:/i.test(link.target) && !shown.includes('@')) out += ` ${link.target.slice(7).split('?')[0]}`;
      link = null;
    }
  }
}

async function docxText(bytes) {
  const { unzipSync, strFromU8 } = await import('fflate');
  // Name and contact details are often typed into the page header, which Word stores apart from the body.
  const part = /^word\/(?:_rels\/)?(header\d*|document|footer\d*)\.xml(?:\.rels)?$/;
  let oversized = false;
  const files = unzipSync(bytes, { filter: (f) => part.test(f.name) && (f.originalSize <= MAX_PART || !(oversized = true)) });
  if (oversized) throw new Error('This Word file unpacks to more than can be read here.');
  const rank = (name) => (name.includes('header') ? 0 : name.includes('document') ? 1 : 2);
  const names = Object.keys(files).filter((name) => !name.endsWith('.rels')).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true }));
  const parts = names.map((name) => {
    // Where a link goes is kept in a side file.
    const rels = files[name.replace('word/', 'word/_rels/') + '.rels'];
    const targets = new Map();
    if (rels) {
      const list = strFromU8(rels);
      for (const tag of list.slice(0, list.lastIndexOf('>') + 1).match(/<Relationship\b[^>]*>/g) || []) {
        const id = /\bId="([^"]*)"/.exec(tag), target = /\bTarget="([^"]*)"/.exec(tag);
        if (id && target) targets.set(id[1], xmlEntities(target[1]));
      }
    }
    return { text: xmlEntities(wordXmlText(strFromU8(files[name]), targets)), footer: name.includes('footer') };
  }).filter((part) => part.text.trim());
  // Which lines come from a page footer: contact details put there belong to the person, whatever section the body ends in.
  return { text: parts.map((part) => part.text).join('\n'), layout: { lines: parts.flatMap((part) => part.text.split('\n').map(() => ({ footer: part.footer }))) } };
}

// RTF groups that describe the document rather than hold its text.
const RTF_SKIP = /^(?:fonttbl|colortbl|stylesheet|info|pict|object|themedata|colorschememapping|datastore|latentstyles|listtable|listoverridetable|rsidtbl|revtbl|generator|fldinst|xmlnstbl|filetbl|footnote|annotation|shpinst)$/;
const RTF_WORDS = { par: '\n', line: '\n', sect: '\n', page: '\n', row: '\n', tab: '\t', cell: '\t', emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ' };

function rtfText(rtf) {
  let ansi = new TextDecoder('windows-1252'); // what \'xx bytes are written in, unless the file names another code page
  const stack = [];
  let out = '', i = 0, skip = false, uc = 1, fallback = 0; // fallback: plain characters still to drop after a \uN
  const emit = (ch) => { if (fallback > 0) fallback--; else if (!skip) out += ch; };
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') { stack.push([skip, uc]); fallback = 0; i++; }
    else if (ch === '}') { [skip, uc] = stack.pop() || [false, 1]; fallback = 0; i++; }
    else if (ch === '\r' || ch === '\n') i++; // line ends in the file itself mean nothing
    else if (ch !== '\\') { emit(ch); i++; }
    else {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') { emit(next); i += 2; }
      else if (next === '\r' || next === '\n') { emit('\n'); i += rtf.startsWith('\r\n', i + 1) ? 3 : 2; } // TextEdit ends paragraphs with a bare backslash
      else if (next === "'") { emit(ansi.decode(new Uint8Array([parseInt(rtf.slice(i + 2, i + 4), 16) || 63]))); i += 4; }
      else if (next === '*') { skip = true; i += 2; }
      else if (next === '~') { emit(' '); i += 2; }
      else if (next === '_') { emit('-'); i += 2; }
      else {
        const word = /^([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i + 1, i + 48));
        if (!word) { i += 2; continue; }
        i += 1 + word[0].length;
        const [, name, number] = word;
        if (name === 'u' && number) { if (!skip) out += String.fromCharCode(+number < 0 ? +number + 65536 : +number); fallback = uc; continue; }
        fallback = 0;
        if (RTF_SKIP.test(name)) skip = true;
        else if (name === 'uc') uc = +number || 0;
        else if (name === 'ansicpg') { try { ansi = new TextDecoder(`windows-${number}`); } catch { /* not a code page browsers know: keep the default */ } }
        else if (name === 'bin') i += +number || 0;
        else if (RTF_WORDS[name]) emit(RTF_WORDS[name]);
      }
    }
  }
  return out;
}

// ---------- guessing the fields ----------
const LINKEDIN = /linkedin\.com\/(?:in|pub)\//i;
const TITLE_WORDS = /\b(engineer|developer|programmer|architect|manager|director|designer|analyst|scientist|consultant|specialist|coordinator|administrator|officer|executive|lead|head|chief|founder|president|vp|svp|evp|ceo|cto|cfo|coo|cio|cmo|recruiter|accountant|bookkeeper|controller|auditor|nurse|physician|doctor|teacher|lecturer|professor|tutor|instructor|trainer|researcher|postdoctoral|technician|operator|supervisor|foreman|assistant|associate|advisor|adviser|strategist|planner|buyer|writer|copywriter|editor|journalist|producer|marketer|representative|agent|partner|intern|trainee|apprentice|owner|sales|marketing|product|operations|finance|counsel|lawyer|attorney|solicitor|paralegal|surgeon|pharmacist|therapist|driver|chef|barista|cashier|receptionist|secretary|clerk|mechanic|electrician|economist|translator|freelancer|contractor|worker|carer|caregiver|cleaner|housekeeper|caretaker|waiter|waitress|bartender|labourer|laborer|operative|attendant|practitioner|midwife|paramedic|dentist|inspector|superintendent|surveyor|estimator|underwriter|broker|trader|investigator|hairdresser|stylist|plumber|carpenter|welder|machinist|installer|courier|dispatcher|merchandiser|photographer|illustrator|animator|librarian|curator|ingenieur|entwickler|leiter|berater|analyste|contrôleu(?:r|se)|ingénieure?|développeu(?:r|se)|direct(?:eur|rice)|responsable|chef(?:fe)? de projet|chargée? de|gestionnaire|comptable|gerente|ingenier[oa]|desarrollador|analista|consultora?|diretora?|engenheir[oa])\b|(?:leiter|berater|entwickler|ingenieur|referent|sachbearbeiter|geschäftsführer)(?:in)?\b|(?:kaufmann|kauffrau)\b/i;
// Words that make a line a job title even when its last word could be a surname ("Delivery Driver", "Staff Nurse").
const QUALIFIERS = new Set('senior junior principal staff deputy vice general managing global regional national account accounts program programme hardware systems system technical tech team delivery truck bus taxi lorry forklift store shop retail legal medical dental clinical registered charge practice graphic interior fashion industrial mechanical electrical civil chemical sous pastry security test content copy creative art visual social media brand supply chain logistics warehouse production plant site construction maintenance commercial corporate investment risk credit tax audit payroll recruitment people primary secondary teaching lab laboratory field process safety environmental events event travel property insurance claims loan mortgage banking executive'.split(' '));
// Never part of a person's name: document furniture, headings, sign-offs, skills, kinds of organisation.
const NEVER_NAME = new Set(('curriculum vitae resume cv profile summary objective contact contacts details personal information info experience experiences education skills skill address phone telephone email mail mobile linkedin github portfolio website references referees reference cover letter application statement about career history employment work professional background qualifications qualification certifications certification certificates achievements accomplishments awards honors honours interests hobbies languages projects publications training courses volunteer volunteering activities additional technical core competencies highlights overview expertise strengths tools technologies date birth nationality gender marital status declaration invoice amount due total number confidential draft signature availability '
  + 'dear regards sincerely yours faithfully wishes thanks thank hello hiring sir madam whom concern your name first last lorem ipsum '
  + 'job description notes meeting minutes agenda contents candidate applicant client team licence license driving stack excellent experienced motivated dedicated reliable hardworking working passionate '
  + 'data engineering software development management design analysis analytics science machine learning cloud computing project business digital financial accounting customer services support research communication communications leadership strategy planning human resources web network quality assurance testing programming microsoft office excel powerpoint python java javascript sql apache spark aws azure google adobe photoshop figma agile scrum native bilingual fluent proficient intermediate beginner '
  + 'ltd limited inc llc llp plc gmbh corp corporation company group holdings university college school institute academy bank hospital clinic solutions technology consulting consultancy partners associates labs studio studios agency foundation trust council department ministry association society international industries enterprises ventures capital talent recruitment staffing health healthcare care').split(' '));
const LANGUAGES = new Set('english french german spanish hindi urdu mandarin chinese cantonese arabic portuguese italian russian japanese korean dutch swedish norwegian danish finnish polish turkish greek hebrew bengali punjabi tamil telugu marathi gujarati swahili vietnamese thai indonesian malay'.split(' '));
const FILE_WORDS = new Set('untitled document documents scanned scan scanner version template templates page pages file files image img photo screenshot download export print office black white grey gray blue green red pink purple orange yellow beige brown gold minimalist minimal modern simple elegant creative clean classic basic colorful colourful corporate big small large mb kb gb'.split(' '));
const HONORIFICS = new Set('dr mr mrs ms miss mx prof professor sir eng ing'.split(' '));
const PARTICLE = /^(?:de|da|del|della|di|dos|das|du|van|von|der|den|ter|ten|la|le|el|al|bin|binti|ibn|y|e|zu)$/;
// Letters after a name, and whatever follows them: any of them after a comma, only the unmistakable ones without
// ("LI MA" is a name).
const POSTNOMINALS = /(?:,\s*(?:PMP|MBA|CPA|CFA|PhD|Ph\.D\.?|DPhil|MD|RN|PE|JD|ACA|FCA|ACCA|CIMA|CISSP|MSc|BSc|MEng|BEng|MA|BA|LLB|LLM|MCIPD|FCIPD|CEng|Esq\.?|Jr\.?|Sr\.?|II|III)|\s+(?:PMP|MBA|CPA|CFA|PhD|Ph\.D\.?|DPhil|ACCA|CIMA|CISSP|MSc|BSc|MEng|BEng|LLB|LLM|MCIPD|FCIPD))(?=$|[,\s]).*$/;
const COMPANY_WORDS = /\b(?:ltd|limited|inc|llc|llp|plc|gmbh|ag|corp|corporation|company|co|group|holdings|university|college|school|institute|bank|hospital|council|nhs|society|association|club|union|committee|foundation|charity|s\.?a\.?|b\.?v\.?|pty)\.?$/i;
const PLACES = new Set(('united kingdom|uk|england|scotland|wales|northern ireland|ireland|united states|usa|canada|australia|new zealand|india|pakistan|bangladesh|sri lanka|nepal|china|hong kong|singapore|malaysia|indonesia|philippines|thailand|vietnam|japan|south korea|taiwan|uae|united arab emirates|saudi arabia|qatar|kuwait|bahrain|oman|israel|turkey|egypt|nigeria|ghana|kenya|south africa|ethiopia|uganda|tanzania|morocco|germany|france|spain|portugal|italy|netherlands|belgium|luxembourg|switzerland|austria|sweden|norway|denmark|finland|iceland|poland|czech republic|czechia|slovakia|hungary|romania|bulgaria|greece|ukraine|russia|serbia|croatia|estonia|latvia|lithuania|brazil|argentina|chile|colombia|peru|mexico|deutschland|espana|italia|nederland|schweiz|osterreich|'
  + 'london|manchester|birmingham|leeds|liverpool|bristol|sheffield|newcastle|nottingham|glasgow|edinburgh|cardiff|belfast|dublin|cork|new york|new york city|nyc|los angeles|san francisco|san diego|san jose|seattle|chicago|boston|austin|dallas|houston|atlanta|miami|denver|phoenix|philadelphia|washington|washington dc|toronto|vancouver|montreal|ottawa|calgary|sydney|melbourne|brisbane|perth|auckland|wellington|mumbai|delhi|new delhi|bangalore|bengaluru|hyderabad|chennai|pune|kolkata|ahmedabad|gurgaon|gurugram|noida|karachi|lahore|islamabad|dhaka|colombo|beijing|shanghai|shenzhen|guangzhou|tokyo|osaka|seoul|taipei|bangkok|jakarta|manila|kuala lumpur|ho chi minh city|hanoi|dubai|abu dhabi|doha|riyadh|jeddah|tel aviv|istanbul|cairo|lagos|abuja|accra|nairobi|johannesburg|cape town|addis ababa|kampala|casablanca|berlin|munich|munchen|hamburg|frankfurt|cologne|koln|stuttgart|dusseldorf|paris|lyon|marseille|toulouse|madrid|barcelona|valencia|seville|lisbon|porto|rome|milan|turin|amsterdam|rotterdam|the hague|utrecht|eindhoven|brussels|antwerp|zurich|geneva|basel|vienna|stockholm|gothenburg|malmo|oslo|copenhagen|helsinki|reykjavik|warsaw|krakow|prague|budapest|bucharest|sofia|athens|kyiv|moscow|belgrade|zagreb|tallinn|riga|vilnius|sao paulo|rio de janeiro|buenos aires|santiago|bogota|lima|mexico city|'
  + 'california|texas|florida|illinois|massachusetts|ontario|quebec|british columbia|new south wales|queensland|bavaria|catalonia|remote').split('|'));
// The state, province and country codes that end an address line ("Austin, TX", "Sydney NSW", "Leeds, UK").
const REGION_CODE = /^(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|NSW|VIC|QLD|TAS|ACT|NT|UK|US|USA|UAE)$/;
// How place names start that are not in the list above ("North Yorkshire", "Santa Clara", "St Albans").
const PLACE_START = /^(?:north|south|east|west|new|san|santa|saint|st|los|las|costa|puerto|fort|port|mount|lake|cape|upper|lower|greater)\.? /i;

/** Lower case without accents, so "MÜLLER", "Müller" and "muller" compare equal. */
const plain = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const lettersOf = (s) => plain(s).replace(/[^a-z]/g, '');
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\bMc(\p{Ll})(?=\p{Ll}{2})/gu, (m, c) => `Mc${c.toUpperCase()}`); // "MCDONALD" is McDonald
const SEPARATOR = /\s*[|•·●▪■◆‣∙│¦⋄◊♦]\s*/;
const DASH = /\s+[–—-]\s+/;
const EDGES = /^[\s|•·●▪■◆‣∙│¦⋄◊♦,;:–—()[\]/-]+|[\s|•·●▪■◆‣∙│¦⋄◊♦,;:–—()[\]/-]+$/g;
/** Without the punctuation left at either end when a line is cut up, keeping a closing bracket that has its opening one. */
const tidy = (s) => { const t = s.replace(EDGES, ''); return t.includes('(') && !t.includes(')') ? `${t})` : t; };

// Section headings, matched without accents or case. The first kind holds someone else's details; "References
// available on request" lists nobody, so it opens nothing.
const HEAD_REFS = /^(?:(?:my|work|professional|personal|character|academic|employment|business|two|three) )?(?:references|referees?|referenzen|referencias|referenties)(?: (?:details|contacts?|list|and contacts?|\(.{0,30}))?$|^(?:(?:professional|personal|character|academic|employment) )?reference$|^reference (?:details|contacts?)$|^(?:emergency contacts?(?: details)?|next of kin)$/;
const HEAD_CONTACT = /^(?:contact(?: (?:details|information|info|me))?|personal (?:details|information|info|data|particulars)|get in touch|kontakt|kontaktdaten|personliche daten|coordonnees|contacto|datos personales)$/;
const HEAD_EXPERIENCE = /^(?:(?:professional|work|working|career|relevant|employment|industry|related|recent|selected|research|teaching|academic|clinical|practical|job|previous|internship) )?(?:experiences?|employment|history)(?: history| record| and \w+)?$|^(?:work|career|employment|professional|job) (?:history|background)$|^(?:work|career)$|^(?:(?:academic|professional|research|faculty) )?(?:appointments|positions)(?: held)?$|^(?:berufserfahrung|beruflicher werdegang|berufliche laufbahn|werdegang|experiences? professionnelles?|parcours professionnel|arbeitserfahrung|experiencias?(?: laboral(?:es)?| profesional(?:es)?| profissiona(?:l|is))?|esperienz[ae](?: lavorativ[ae]| professional[ei])?|werkervaring|doswiadczenie(?: zawodowe)?)$/;
const HEAD_OTHER = /^(?:(?:professional|personal|career|executive|technical|key|core|top|relevant|additional|other|selected|academic|educational|soft|computer|language|it) )*(?:summary|profile|objective|statement|about(?: me)?|overview|education(?: and \w+)?|qualifications?|skills?(?: and \w+)?|competenc(?:ies|es)|expertise|areas of expertise|strengths|languages?|certifications?|certificates?|licen[sc]es?(?: and certifications)?|courses?|training|awards?(?: and \w+)?|honou?rs?(?: and awards)?|achievements?|accomplishments?|publications?|presentations?|conferences?|projects?|interests?|hobbies(?: and interests)?|activities|volunteer(?:ing)?(?: work| experience)?|memberships?|affiliations?|patents?|grants?|research(?: interests)?|teaching|information|highlights|technologies|tools|declaration|ausbildung|kenntnisse|sprachen|formation|competences|langues|educacion|formacion(?: academica)?|habilidades|idiomas|formacao(?: academica)?|educacao|competencias|istruzione|competenze|lingue|opleiding|vaardigheden|wyksztalcenie|umiejetnosci)$/;

/** Which kind of section a line opens ('refs', 'contact', 'experience', 'other'), or null when it is not a heading. */
function headingOf(text) {
  for (const piece of plain(text).split(/\s*[/|·]\s*/)) {
    const t = piece.replace(/&/g, 'and').replace(/^[^a-z]+|[^a-z]+$/g, '').replace(/\s+/g, ' ');
    if (!t || t.length > 45 || t.split(' ').length > 5) return null;
    if (HEAD_REFS.test(t)) return 'refs';
    if (HEAD_CONTACT.test(t)) return 'contact';
    if (HEAD_EXPERIENCE.test(t)) return 'experience';
    if (HEAD_OTHER.test(t)) return 'other';
  }
  return null;
}

/** The text as lines, each knowing its section, its column parts and (where the format says) its font size and page. */
function readLines(text, layout = []) {
  const lines = [];
  let gap = true; // whether an empty line stands above
  text.split(/\r?\n/).forEach((raw, i) => {
    // No name, address or number is hundreds of characters without a space. Such a run (a line of digits, an
    // embedded picture written out as text) is dropped: the patterns below would try it from every position.
    let t = raw.replace(/\S{200,}/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[\u00a0\u2000-\u200a\u202f]/g, ' ').trim();
    if (!t) gap = true;
    if (!t || /^page \d+(?: of \d+)?$|^\d{1,3}(?: ?(?:of|\/) ?\d{1,3})?$/i.test(t)) return; // blank, or a page number
    t = unspace(t).replace(/\s*\t\s*| {3,}/g, ' · ').replace(/\s+/g, ' ');
    lines.push({ text: t, parts: t.split(SEPARATOR).map((p) => p.trim()).filter(Boolean), size: layout[i]?.size || 0, page: layout[i]?.page || 1, footer: Boolean(layout[i]?.footer), gap });
    gap = false;
  });
  let section = 'head', others = false;
  for (const line of lines) {
    const heading = line.footer ? null : headingOf(line.text);
    if (heading) { section = heading; line.heading = true; }
    line.section = line.footer ? 'contact' : section;
    // "Consultant: Sarah Lee, sarah.lee@agency…" on an agency's cover sheet, "Supervisor: …" in a job entry: the
    // details on that line, and on the lines straight under it, are that person's and not the candidate's.
    if (OTHER_PERSON.test(line.text)) others = true;
    else if (line.gap || heading) others = false;
    line.others = others;
  }
  return lines;
}
const OTHER_PERSON = /^(?:(?:consultant|recruiter|your contact|agency contact|account manager|referees?|references?|supervisor|line manager|manager|reports? to|reporting to)\s*:|(?:presented|prepared|submitted|introduced|sent|represented) by\b\s*[:–-]?)\s*\S/i;

const isPlace = (s) => {
  const t = plain(s).replace(/[.]/g, '').trim();
  return PLACES.has(t) || /^greater \p{L}+|(?: bay)? area$| metropolitan area$/u.test(t);
};

/**
 * Line numbers in the order to search them for the candidate's own details: the top of the document and any
 * "Contact" section first (an address in the work history may be a client's), and never a References section.
 */
function contactFirst(lines) {
  const own = lines.map((l, i) => i).filter((i) => lines[i].section !== 'refs' && !lines[i].others);
  const top = (i) => lines[i].section === 'head' || lines[i].section === 'contact';
  return [...own.filter(top), ...own.filter((i) => !top(i))];
}

// ----- email -----
const EMAIL = /[A-Za-z0-9][A-Za-z0-9._%+'-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

/** The first address outside a References section. One cut in two by a line break is joined back, or dropped. */
function findEmail(lines) {
  for (const i of contactFirst(lines)) {
    const { text } = lines[i];
    const next = lines[i + 1]?.section === 'refs' || lines[i + 1]?.others ? '' : lines[i + 1]?.text || '';
    // The line ends inside the address ("name@", "name@mail." or "name@my-"): the rest is the next line, or nothing is taken.
    const cut = /[A-Za-z0-9][A-Za-z0-9._%+'-]*@(?:[A-Za-z0-9-]+\.)*(?:[A-Za-z0-9-]*-)?$/.exec(text);
    if (cut && !EMAIL.test(cut[0].replace(/\.$/, ''))) {
      const whole = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(next) && EMAIL.exec(cut[0] + next);
      if (whole && /[\p{L}\p{M}’‘`]$/u.test(text.slice(0, cut.index))) return null;
      if (whole) return { value: whole[0].toLowerCase(), line: i };
      continue;
    }
    const found = EMAIL.exec(text);
    if (!found) continue;
    // An accented letter or a curly apostrophe in front means the address starts earlier than the letters this
    // reader knows: "josé.garcía@…" would come out as "a@…", a different and valid-looking address. Nothing is taken.
    if (/[\p{L}\p{M}’‘`]$/u.test(text.slice(0, found.index))) return null;
    let value = found[0];
    const rest = text.slice(found.index + value.length);
    if (rest === '' && /^\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(next)) value += next; // ".co.uk" on the next line
    else if (rest === '.' && /^[a-z]{2,3}$/.test(next)) value += `.${next}`; // "name@mail.co." then "uk"
    return { value: value.toLowerCase(), line: i };
  }
  return null;
}

// ----- LinkedIn -----
const LINK = /(?:[a-z]{2,3}\.)?linkedin\.com\/(in|pub)\/([^\s|•·,;()<>"']*)/i;
const SLUG_PIECE = /^[A-Za-z0-9%_-]+$/;

/** A profile link in its stored form, or null when it is not a usable member link (too short, or visibly cut off). */
function profileLink(kind, path) {
  const clean = path.split(/[?#]/)[0].replace(/[.)\]]+$/, '').replace(/\/+$/, '');
  if (kind.toLowerCase() === 'pub') { // legacy links carry the member's number in the later parts of the path
    const whole = clean.split('/').slice(0, 4).join('/').toLowerCase();
    return whole.length >= 3 && !whole.endsWith('-') ? `https://www.linkedin.com/pub/${whole}` : null;
  }
  const slug = clean.split('/')[0].toLowerCase();
  return slug.length >= 3 && !slug.endsWith('-') ? `https://www.linkedin.com/in/${slug}` : null;
}

function findLinkedin(lines, links = []) {
  // Addresses taken from the file's own links are complete even when the printed text is not.
  const linked = [...new Set(links.map((url) => { const m = LINK.exec(url); return m && profileLink(m[1], m[2]); }).filter(Boolean))];
  for (const i of contactFirst(lines)) {
    const m = LINK.exec(lines[i].text);
    if (!m) continue;
    let path = m[2], unsure = false;
    const rest = lines[i].text.slice(m.index + m[0].length);
    if (!rest.trim()) {
      // The address runs to the end of its line, so it may continue below. LinkedIn's own PDF export marks the end
      // with "(LinkedIn)". Otherwise a line is joined on only when it is plainly the rest: a lone lower-case piece
      // after a hyphen, or one shaped like the end of such an address ("ta-engineer-4a81b22b").
      const below = lines.slice(i + 1, i + 4).filter((l) => l.section !== 'refs').map((l) => l.text);
      const end = below.findIndex((t) => /^[A-Za-z0-9%_-]*\s*\(LinkedIn\)$/i.test(t));
      if (end >= 0 && below.slice(0, end).every((t) => SLUG_PIECE.test(t))) path += below.slice(0, end + 1).join('').replace(/\s*\(LinkedIn\)$/i, '');
      else for (const line of below) {
        const t = line.replace(/\/$/, '');
        if (!SLUG_PIECE.test(t) || t !== t.toLowerCase() || /^\d+$/.test(t)) break;
        const hyphen = t.includes('-'), digit = /\d/.test(t);
        if (path.endsWith('-') || path === '' || (hyphen && digit)) { path += t; continue; }
        unsure = hyphen || digit; // "b22b" may be the end of the address or a word of its own: the page does not say
        break;
      }
    }
    const stem = `https://www.linkedin.com/${m[1].toLowerCase()}/${path.split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase()}`;
    return linked.find((url) => url.startsWith(stem)) || (unsure ? null : profileLink(m[1], path));
  }
  return linked.length === 1 ? linked[0] : null;
}

// ----- phone -----
const PHONE = /(?:(?:(?:\+|00)\d{1,3}[ .-]?)?(?:\(\+?\d{1,5}\)[ .-]?)?\d{1,5}(?:[ .-]?\d{1,5}){1,6}|0\d{2,4} ?\/ ?\d{2,5}(?:[ -]?\d{2,5}){1,3})(?![\w\/%@-]|[.,]\d|\s?(?:[%€$£]|(?:usd|eur|gbp|million|billion|bn|mio|k|m)\b))/gi;
const PHONE_LABEL = /(?:\b(?:tel|telephone|phone|ph|mobile|mobil|mob|cell|cellphone|handphone|hp|handy|telefon|telefono|tél|téléphone|móvil|movil|whatsapp|contact)\.?(?: (?:no|number|nr)\.?)?\s*[:.)#–-]*|(?:^|[\s(|·•])[mtpc]\s*[:.)]+)\s*$/i;
const NOT_PHONE_LABEL = /\b(?:ref|reference|invoice|order|account|acct|iban|id|no|nr|number|code|isbn|issn|doi|orcid|vat|nif|ssn|nric|cpf|cnic|bvn|nin|tfn|aadhaa?r|pan|passport|licen[cs]e|registration|student|employee|dob|born|birth|fax|pin|zip|postcode|gpa|cgpa|grade|score)\b\W*$/i;
// A number followed by what it counts ("100 200 300 units") is not a phone; one followed by which phone it is, is.
const COUNTED = /^\s+(?!(?:and|und|oder|mobile?|cell|home|work|tel|direct|office|whatsapp|ext|personal)\b)\p{Ll}{3,}/u;
const YEAR = /(?:^|\D)(?:19|20)\d{2}(?!\d)/g;
// "Social Security: 123-45-6789", "NI: 12 34 56 78 9": a label for something else. Which phone it is ("Home:") is not.
const OTHER_LABEL = /\p{L}[\p{L} .'’/-]{0,30}:\s*$/u;
const WHICH_PHONE = /\b(?:home|work|office|direct|personal|landline|main|daytime|evening|private|business|uk|usa?)\s*:\s*$/i;
// How a number is written when nothing says it is a phone: with a leading 0 or an area code in brackets, or in
// one of the national forms. Nine to twelve digits of any other shape are as likely a student or tax number.
const PHONE_SHAPES = [
  /^[(0]/,
  /^(?:1[ .-])?\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}$/, // North America
  /^[2-9]\d{9}$/, // ten digits run together (North America, India)
  /^[6-9]\d{4}[ -]\d{5}$/, // India
  /^1[3-9]\d[ -]?\d{4}[ -]?\d{4}$/, // China
  /^[36789]\d{1,2}(?:[ .]\d{2,4}){2,3}$/, // Spain, Portugal, Italy
];

/**
 * A phone number: one with a label ("Tel:", "Mobile"), else one in the contact block, else one written in
 * international form. Date ranges, dates of birth, postcodes and reference numbers are never taken.
 */
function findPhone(lines, inContact) {
  const found = [];
  lines.forEach((line, i) => {
    if (line.section === 'refs' || line.others) return;
    for (const m of line.text.matchAll(PHONE)) {
      const value = m[0].trim(), digits = value.replace(/\D/g, '').length, before = line.text.slice(0, m.index);
      const labelled = PHONE_LABEL.test(before), international = /^(?:\+|00)/.test(value);
      // Part of something longer: a code, an amount ("£1 200 000"), a web address, or the tail of another number.
      if (/[\w.\/$£€#-]$/.test(before) || (/\d[ .,-]$/.test(before) && /^\d/.test(value))) continue;
      if (!labelled && (NOT_PHONE_LABEL.test(before) || COUNTED.test(line.text.slice(m.index + m[0].length)))) continue;
      if (!labelled && OTHER_LABEL.test(before) && !WHICH_PHONE.test(before)) continue;
      if (!labelled && !international && !PHONE_SHAPES.some((shape) => shape.test(value))) continue;
      if (/^\d{1,3}(?:\.\d{1,3}){3}$|(?:^|\s)\d\.\d{1,2}(?=\s|$)/.test(value)) continue; // a network address, or figures such as "3.85 4.00"
      if ((value.match(YEAR) || []).length >= 2 || /^\d{1,2}[ .-]\d{1,2}[ .-](?:19|20)\d{2}$|^(?:19|20)\d{2}[ .-]\d{1,2}[ .-]\d{1,2}$|^\d{5}-\d{4}$/.test(value)) continue;
      if (!labelled && !international && /^(?:19|20)\d{2}(?!\d)/.test(value)) continue; // "2026-00417" is a reference, "2019 ..." a date
      if (digits < (labelled ? 7 : international ? 8 : 9) || digits > (international ? 15 : 12)) continue;
      found.push({ value, labelled, international, contact: inContact(i) });
    }
  });
  return (found.find((p) => p.contact && p.labelled) || found.find((p) => p.contact) || found.find((p) => p.labelled) || found.find((p) => p.international))?.value;
}

// ----- name -----
const DOC_TITLE = /^(?:(?:professional|personal|my) )?(?:curriculum vitae|resume|résumé|cv|c\.v\.)(?:\s*[/(]\s*(?:cv|resume|résumé)\)?)?$/i;
// What a page header holds besides: the name comes after a line made only of these.
const FURNITURE = /^(?:page(?: \d+)?(?: of \d+)?|(?:private (?:and|&) |strictly )?confidential)$/i;

/** A line part read as a person's name, or null when it cannot be one. `soft` marks one that could as well be a job, a language or a place. */
function asName(part) {
  let s = part.replace(/^(?:resume|résumé|cv|curriculum vitae)\s*(?:of|for|[:–—-])\s*/i, '').replace(/(?:['’]s)?\s*[:,–—-]?\s*\b(?:resume|résumé|cv|curriculum vitae)$/i, '');
  s = s.replace(/\s*\([^)]*\)$/, '').replace(/\s+["“][^"”]+["”](?=\s)/, '').replace(POSTNOMINALS, '').replace(/,$/, '').trim();
  // "Alex Morgan MD", "Jane Doe BSN": capitals after a name written in normal case are letters after it, whichever they are.
  s = s.replace(/^(\p{Lu}\p{Ll}[\p{L}'’-]*\.? \p{Lu}\p{Ll}[\p{L}'’-]*) (?:[A-Z]{2,5}|Jr\.?|Sr\.?)$/u, '$1');
  if (s.length < 4 || s.length > 45 || /[\d@/\\:;,!?&+=#*_()[\]{}<>"“”]/.test(s)) return null;
  const words = s.split(' ');
  if (words.length < 2 || words.length > 5) return null;
  const lower = s === s.toLowerCase();
  if (!words.every((w) => PARTICLE.test(w) || /^\p{Lu}[\p{L}'’-]*\.?$/u.test(w) || (lower && /^\p{L}[\p{L}'’-]*$/u.test(w)))) return null;
  const tokens = s.split(/[\s-]+/).map(lettersOf).filter((t) => t && !HONORIFICS.has(t)); // "Adeyemi-Jones" is two names
  if (!tokens.some((t) => t.length >= 2) || tokens.join('').length < 4 || tokens.some((t) => NEVER_NAME.has(t))) return null;
  const titled = tokens.filter((t) => TITLE_WORDS.test(t));
  // "Adam Driver": only the surname reads as a job, which a line such as "Delivery Driver" or "Product Manager" never does.
  const surnameOnly = titled.length === 1 && titled[0] === tokens[tokens.length - 1] && !tokens.some((t) => QUALIFIERS.has(t) || LANGUAGES.has(t));
  if (titled.length && !surnameOnly) return null;
  const soft = surnameOnly || tokens.some((t) => LANGUAGES.has(t)) || isPlace(s) || tokens.every((t) => PLACES.has(t)) || PLACE_START.test(s) || /\b(?:united|kingdom|states|city|county|street|road|avenue)\b/i.test(s);
  return {
    // All capitals or none become normal case; so does a surname written in capitals ("WHITFIELD Hannah").
    name: lower || s === s.toUpperCase() ? titleCase(s) : words.map((w) => (w.length > 2 && w === w.toUpperCase() ? titleCase(w) : w)).join(' '), tokens, lower, soft, surnameOnly,
  };
}

/** The runs of letters in the first half of an email address or in a file name: "rohan.mehta88" gives rohan, mehta. */
const wordsOf = (s) => plain(s).split(/[^a-z]+/).filter(Boolean);

/**
 * How many of a name's words open or close one of those runs ("Rohan Mehta" in rohan.mehta88, "Jane Doe" in
 * jdoe: 2 and 1). A word in the middle of a run is chance: "MIT" is in jsmith.
 */
function agreement(tokens, runs) {
  const real = tokens.filter((t) => t.length >= 3);
  const found = (t) => runs.some((run) => run.startsWith(t) || run.endsWith(t));
  const n = real.filter((t) => found(t) || found(t.replace(/([aou])(?=[^aeiou])/g, '$1e'))).length; // "Müller" in mueller
  return { n, full: n >= 2 && n === real.length };
}

/**
 * The person's name, from the strongest evidence there is: a "Name:" label, a line that agrees with the email
 * address or the file name, the largest text on the first page of a PDF, or the very first line. Anything weaker
 * (the first name-shaped line somewhere near the top) picks up headings, skills and places, so it is left empty.
 * `reachable` says the document carries contact details of its own, which a résumé does and a job description,
 * a set of notes or an agency's cover sheet often does not.
 */
function findName(lines, email, hints, reachable) {
  const top = lines.slice(0, 60);
  for (const line of top.slice(0, 40)) {
    if (line.section === 'refs') continue;
    for (const [j, part] of line.parts.entries()) {
      // "Name: Rohan Mehta", or the same in two cells of a table.
      const labelled = /^(?:full name|name|candidate(?: name)?|applicant(?: name)?|nom|nombre|nome)\s*[:–-]\s*(.+)$/i.exec(part) || (/^(?:full name|name)$/i.test(part) && [, line.parts[j + 1] || '']);
      const named = labelled && asName(labelled[1]);
      if (named && !named.lower) return { name: named.name, line: lines.indexOf(line) };
    }
  }

  const emailKey = email ? wordsOf(email.split('@')[0]) : [];
  const fileKey = hints.filename ? wordsOf(hints.filename.replace(/\.[^.]+$/, '')) : [];
  const pool = [];
  top.forEach((line, i) => {
    if (line.section === 'refs' || line.heading || line.others) return;
    line.parts.flatMap((part) => part.split(DASH)).forEach((part, j) => {
      // "Jane Doe, Senior Engineer": the name is what stands before the job title.
      const titled = /^([^,]+),\s*(.+)$/.exec(part);
      const c = asName(titled && TITLE_WORDS.test(titled[2]) ? titled[1].trim() : part.trim());
      if (c) pool.push({ ...c, i, j, size: line.size, page: line.page, byEmail: agreement(c.tokens, emailKey), byFile: agreement(c.tokens, fileKey) });
    });
    // "WHITFIELD, Hannah" is a name only when the email address or the file name says so; otherwise it reads as a place.
    const reversed = /^(\p{Lu}[\p{L}'’-]+),\s+(\p{Lu}[\p{L}'’ .-]+)$/u.exec(line.text);
    const turned = reversed && asName(`${reversed[2]} ${reversed[1]}`);
    if (turned && (agreement(turned.tokens, emailKey).full || agreement(turned.tokens, fileKey).full)) pool.push({ ...turned, i, j: 0, size: line.size, page: line.page, byEmail: agreement(turned.tokens, emailKey), byFile: agreement(turned.tokens, fileKey) });
    // A name set large is often broken over two lines: "AMELIA" above "OKORO".
    const below = top[i + 1];
    if (line.size && below && below.size === line.size && line.page === 1 && /^\p{Lu}[\p{L}'’-]+$/u.test(line.text) && /^\p{Lu}[\p{L}'’-]+$/u.test(below.text)) {
      const c = asName(`${line.text} ${below.text}`);
      if (c) pool.push({ ...c, i, j: 0, size: line.size, page: 1, stacked: true, byEmail: agreement(c.tokens, emailKey), byFile: agreement(c.tokens, fileKey) });
    }
  });
  const pick = (c) => c && { name: c.name, line: c.i + (c.stacked ? 1 : 0) };
  // A job title straight under the line makes it the head of a résumé, and "Adam Driver" a person.
  const headline = (c) => { const below = top[c.i + (c.stacked ? 2 : 1)]; return Boolean(below) && !below.heading && below.text.length <= 60 && isTitle(below.text); };
  // An organisation's address is named after it: "Acme Widgets" above info@acmewidgets.example is a letterhead.
  const domain = email ? lettersOf(email.split('@')[1]) : '';
  const letterhead = (c) => !c.byEmail.n && c.tokens.every((t) => domain.includes(t));
  const plausible = (c) => !c.lower && (c.soft ? c.surnameOnly && headline(c) : headline(c) || (reachable && !letterhead(c)));

  // Both names in the email address settle it, even for a surname such as Driver or French; a file name can be
  // called after a job or a town, so it only backs a line that could not be one.
  const backed = pool.find((c) => (c.soft ? c.byEmail.full : c.byEmail.n >= 2 || c.byFile.n >= 2));
  if (backed) return pick(backed);
  // One word shared with the file name proves nothing: "Barclays_CV.pdf" opens with "Barclays Wealth".
  const partly = pool.find((c) => c.i < 40 && c.byEmail.n && !c.soft && top[c.i].section !== 'experience');
  if (partly) return pick(partly);

  // PDF: the name is the largest thing on the first page, headings aside. If that line is something else, size says nothing.
  const sized = top.filter((l) => l.page === 1 && l.size && !l.heading && !DOC_TITLE.test(l.text) && lettersOf(l.text).length >= 4);
  if (sized.length) {
    const weight = new Map();
    for (const l of lines) if (l.size) weight.set(l.size, (weight.get(l.size) || 0) + l.text.length);
    const body = [...weight].sort((a, b) => b[1] - a[1])[0][0];
    const max = Math.max(...sized.map((l) => l.size));
    // It has to stand out: larger than the headings, and the only name-shaped line of its size.
    const headings = Math.max(0, ...top.filter((l) => l.page === 1 && l.heading).map((l) => l.size));
    const largest = pool.filter((c) => c.page === 1 && c.size >= max - 0.5 && plausible(c));
    if (max >= body * 1.15 && max > headings + 0.5 && largest.length && largest.every((c) => c.i === largest[0].i || c.stacked || c.i === largest[0].i + 1)) return pick(largest.find((c) => c.stacked) || largest[0]);
  }

  // Otherwise only the opening line of the document is trusted, and not when it is set like the headings are
  // (a sidebar that is read first opens with one).
  const start = top.findIndex((l) => !l.parts.every((part) => DOC_TITLE.test(part) || FURNITURE.test(part)));
  // "Résumé – Jane Doe": the name may stand second on that line.
  const second = start >= 0 && DOC_TITLE.test(top[start].parts[0].split(DASH)[0]) ? 1 : 0;
  const opening = pool.find((c) => c.i === start && c.j === second && !c.stacked && top[start].section === 'head' && plausible(c));
  const likeHeading = opening?.size && top.some((l) => l.heading && l.page === 1 && Math.abs(l.size - opening.size) <= 0.5);
  return (!likeHeading && pick(opening)) || null;
}

// ----- location -----
const DEGREE = /^(?:BSc|MSc|BA|MA|BS|MS|PhD|MBA|BEng|MEng|LLB|LLM|ACA|ACCA|CFA|CPA|PMP|MD|RN|HND|BTEC|GCSE)$/i;
const REGION = /^[\p{L}][\p{L} .'’-]{1,30}$/u;

// What a "Personal details" block lists in the same shape as a place: "Indian, Hindu", "British, Single".
const NOT_A_PLACE = /\b(?:indian|british|american|pakistani|bangladeshi|nigerian|ghanaian|kenyan|filipino|chinese|hindu|muslim|christian|sikh|buddhist|jewish|catholic|married|unmarried|single|male|female)\b/i;

/** A part of a contact line read as a place ("Leeds, UK", "Greater Manchester", "Springfield, IL 62704"), or null. */
function asLocation(part) {
  const s = part.replace(/\s*\([^)]*\)$/, '').trim();
  if (!s || /[\d@:/]|linkedin|github|http|www\./i.test(s) || TITLE_WORDS.test(s) || NOT_A_PLACE.test(s)) return null;
  if (isPlace(s)) return s;
  const pieces = /^\p{Lu}[\p{L}.'’-]+(?: \p{Lu}[\p{L}.'’-]+){0,2} [A-Z]{2,3}$/u.test(s) ? [s] : s.split(/\s*,\s*/); // "Sydney NSW"
  if ((pieces.length < 2 && !/ [A-Z]{2,3}$/.test(s)) || pieces.length > 3 || !pieces.every((p) => REGION.test(p) && p.split(' ').length <= 4)) return null;
  // "MBA, CFA" and "BSc, MSc" are letters after a name: a place starts with a word, and only its last part may be a code.
  if (s !== s.toUpperCase() && pieces.slice(0, -1).some((p) => p === p.toUpperCase())) return null;
  if (pieces.some((p) => DEGREE.test(p)) || (s === s.toUpperCase() && pieces[0].length < 4)) return null;
  // "English, Urdu" is a list of languages, "Chennai, Tamil Nadu" a city and its state.
  if (pieces.some((p) => p.split(' ').some((w) => NEVER_NAME.has(lettersOf(w)) || (LANGUAGES.has(lettersOf(w)) && !pieces.some(isPlace))))) return null;
  // Three parts read as a place only when they end in one we know ("Austin, Texas, United States").
  if (pieces.length === 3 && !isPlace(pieces[2]) && !/^[A-Z]{2,3}$/.test(pieces[2])) return null;
  return s;
}

/** The town in a postal address: "…, Springfield, IL 62704", "…, 75002 Paris", "1015 CJ Amsterdam", "…, Reading, RG1 5AB", "…, Cork, T23 XY12", "Sydney NSW 2000". */
function townOf(part) {
  const m = /(?:^|,\s*)(\p{Lu}[\p{L} .'’-]{1,30},\s*[A-Z]{2})\s+\d{5}(?:-\d{4})?$/u.exec(part)
    || /(?:^|,\s*)(\p{Lu}[\p{L} .'’-]{1,30}? (?:NSW|VIC|QLD|TAS|ACT|NT|SA|WA))\s+\d{4}$/u.exec(part) // not "Deloitte UK 2021"
    || /(?:^|,\s*)\d{4,5}\s+(?:[A-Z]{2}\s+)?(\p{Lu}[\p{L} .'’-]{1,30})$/u.exec(part)
    || /(?:^|,\s*)(\p{Lu}[\p{L} .'’-]{1,30}?),?\s+(?:[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|[A-Z]\d[\dW] ?[A-Z\d]{4})$/u.exec(part);
  return m ? m[1] : null;
}

const PLACE_LABEL = /^(?:(?:(?:home|residential|postal|current|permanent|present) )?address|location|based in|city|residence|lives in|adresse|anschrift|wohnort|ort|domicile|indirizzo|ubicación|dirección|endereço)$/i;

/** Whether a place found by its shape alone ("A, B") names one we know, or ends the way an address line does. */
function knownPlace(s) {
  const pieces = s.split(/\s*,\s*/), last = pieces[pieces.length - 1];
  return isPlace(s) || pieces.some(isPlace) || isPlace(s.replace(/,? [A-Z]{2,3}$/, '')) || REGION_CODE.test(last.split(' ').pop()) || /\p{Ll}shire$/u.test(last);
}

/**
 * Where the person lives, from the contact block only. A labelled address is taken as written; an unlabelled
 * "City, Region" needs either a place we know or a line that is plainly contact details (`strong`), because lists
 * of skills, languages and personal qualities have the same shape.
 */
function findLocation(lines, inContact, strong, name, emailKey) {
  const candidates = lines.map((line, i) => ({ line, i })).filter(({ i }) => inContact(i));
  for (const { line } of candidates) {
    for (const [j, part] of line.parts.entries()) {
      // "Address: …", or the same in two cells of a table. The town is enough where the address shows which it is.
      const labelled = /^([^:–-]{3,30}?)\s*[:–-]\s*(.+)$/.exec(part);
      const value = labelled && PLACE_LABEL.test(labelled[1]) ? labelled[2] : PLACE_LABEL.test(part) ? line.parts[j + 1] : '';
      if (value) return townOf(tidy(value)) || tidy(value.slice(0, 80));
    }
  }
  for (const { line, i } of candidates) {
    if (line.heading) continue;
    for (const part of line.parts.flatMap((p) => p.split(DASH))) {
      if (name && plain(part).includes(plain(name))) continue;
      const town = townOf(part.trim());
      if (town && !TITLE_WORDS.test(town) && !town.split(/[\s,]+/).some((w) => NEVER_NAME.has(lettersOf(w)))) return town;
      const place = asLocation(part.trim());
      if (!place || ((!strong(i) || i === 0) && !knownPlace(place))) continue; // the first line is the name: "Smith, John"
      if (!knownPlace(place) && agreement(place.split(/[\s,]+/).map(lettersOf), emailKey).n) continue; // "Whitfield, Hannah"
      return place;
    }
  }
  return undefined;
}

// ----- current title and company -----
// Month names and their abbreviations in English, German, French, Spanish, Portuguese, Italian and Dutch.
const MONTH = `(?:${('january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec '
  + 'januar februar märz marz mai juni juli oktober dezember okt dez janvier février fevrier mars avril juin juillet août aout septembre octobre novembre décembre decembre janv févr fevr avr juil déc '
  + 'enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre ene abr ago dic janeiro fevereiro março marco maio junho julho setembro outubro dezembro fev set out '
  + 'gennaio febbraio aprile maggio giugno luglio settembre ottobre dicembre gen mag giu lug ott januari februari maart mei augustus mrt spring summer autumn fall winter')
  .split(' ').sort((x, y) => y.length - x.length).join('|')})\\.?`;
const DATE = `(?:\\d{1,2}[./-])?(?:\\d{1,2}[./-]|${MONTH},?\\s*)?(?:19|20)\\d{2}(?:[./-](?:0?[1-9]|1[0-2])(?!\\d))?`;
const UNTIL = "(?:present|current|currently|now|today|(?:to |till )?date|ongoing|heute|jetzt|aujourd['’]hui|présent|actuel|ce jour|actualidad|actualmente|presente|atual|atualmente|oggi|heden)";
const LENGTH = '(?:\\d{1,2}\\+?\\s*(?:years?|yrs?|months?|mos?)\\.?)';
// A date or a range of dates, with the brackets and the "(3 years 2 months)" some layouts add. Only the dates
// themselves are matched, so the words either side of them survive.
const DATES = new RegExp(`(^|[^\\p{L}\\d])(?:\\(?(?:(?:since|from|seit|ab|depuis|desde)\\s+)?${DATE}(?:\\s*(?:-|–|—|to|until|till|bis|au|à|→)\\s*(?:${DATE}|${UNTIL}))?\\)?(?:\\s*[·(,]?\\s*${LENGTH}(?:\\s*${LENGTH})?\\)?)?(?![\\p{L}\\d])|${LENGTH}(?:\\s*${LENGTH})?(?![\\p{L}\\d]))`, 'giu');
const AT = /^(.{2,60}?)\s+(?:at|@|bei|chez)\s+(.{2,60})$/i;
const WORK_TYPE = /^(?:full|part)[- ]time$|^(?:contract|contractor|permanent|temporary|temp|freelance|internship|self[- ]employed|remote|hybrid|on[- ]?site|seasonal|apprenticeship)$/i;
const VERB_FIRST = /^(?:\p{Lu}\p{Ll}+(?:ed|ing)|Led|Built|Ran|Wrote|Drove|Grew|Won|Oversaw|Took|Set|Cut|Made|Responsible)\s+\p{Ll}/u;
/** A line of description rather than of a job entry: a bullet, a full sentence, or one opening "Led the ...". */
function isProse(text) {
  const bare = tidy(text.replace(DATES, '$1 ')), words = bare.split(/\s+/).length;
  return /^[-–*>✓➢◦○•·●▪■◆‣∙\uE000-\uF8FF]/u.test(text) || (/[.!?]$/.test(text) && words >= 4 && !COMPANY_WORDS.test(bare))
    || bare.length > 90 || words > 10 || /^\p{Ll}+(?!\p{Lu})/u.test(bare) || VERB_FIRST.test(bare); // lower case first, "eBay" apart
}
// An employer's name is capitalised words ("eBay" counts) with at most the small words such names have between
// them; "Worked with startups on branding" is not one, nor is a word left over from a date the reader does not know.
const SMALL_WORD = /^(?:of|and|the|for|a|de|du|des|la|le|et|und|für|der|y|e|di|da|do|van|plc|ltd|inc|llc|gmbh)\.?$/;
function orgLike(s) {
  const words = s.split(' '), lower = words.filter((w) => /^\p{Ll}/u.test(w) && !SMALL_WORD.test(w)).length;
  return /^[\p{Lu}\d]|^\p{Ll}+\p{Lu}/u.test(s) && !s.includes(':') && words.length <= 6 && lower <= (words.length > 3 ? 0 : 1);
}
// "Vice President - Engineering": the second half is the department, so part of the title and not the employer.
const DEPARTMENT = /^(?:engineering|technology|it|hr|human resources|legal|compliance|procurement|logistics|supply chain|customer success|people|talent|quality|design|research|strategy|communications|growth|platform|infrastructure|data|analytics|security|risk|audit|tax|treasury|retail|commercial|digital|emea|apac|americas|europe|global)(?: (?:and|&) \p{L}+)?$/iu;
const SUBHEADING = /^(?:(?:key|main|core|major) )?(?:dates?|period|duration|responsibilities|achievements|accomplishments|duties|highlights|projects|role|overview|summary|description|tasks|clients|technologies|tech stack|stack|skills|tools|environment|reporting to\b.*)$/i;
const isTitle = (s) => TITLE_WORDS.test(s) && !COMPANY_WORDS.test(s);

// "Designation: Systems Engineer" and "Employer: Infosys" say outright which is which.
const ROLE_LABEL = 'designation|position(?: held)?|occupation(?: or position held)?|role|job title|title|post';
const FIRM_LABEL = 'company|employer|name (?:and address )?of employer|organi[sz]ation|firm';
const LABELLED = new RegExp(`^(${ROLE_LABEL}|${FIRM_LABEL})\\s*[:–-]\\s*(.+)$`, 'i');
const LABEL = new RegExp(`^(?:${ROLE_LABEL}|${FIRM_LABEL})$`, 'i');
const LABEL_FIRST = new RegExp(`^(?:${ROLE_LABEL}|${FIRM_LABEL})\\s*[:–·-]`, 'i');
const FIRM = new RegExp(`^(?:${FIRM_LABEL})`, 'i');
// What follows a company's name after a comma and is part of it ("Uber Technologies, Inc.").
const SUFFIX = /^(?:inc|llc|llp|ltd|limited|plc|corp|co|gmbh|ag|s\.?a\.?|pty(?: ltd)?|l\.?p)\.?$/i;

/**
 * One line of a job entry as labelled pieces; its dates, places and kind of contract are dropped. Each piece knows
 * its line, which column of the line it stood in (`seg`) and its place in a comma-separated run (`sub`).
 */
function pieces(text, line) {
  const out = [];
  // The Europass form puts its long labels in a column of their own, which may reach us as a single space.
  const segs = text.replace(/^(occupation or position held|name and address of employer) (?=\p{Lu})/iu, '$1: ').replace(DATES, '$1 · ')
    .split(new RegExp(`${SEPARATOR.source}|${DASH.source}`)).map(tidy).filter(Boolean);
  for (let seg = 0; seg < segs.length; seg++) {
    const s = segs[seg];
    if (WORK_TYPE.test(s) || isPlace(s)) continue;
    // A label and its value on one line; in a table the label has a cell to itself and the value is the next one.
    const label = LABELLED.exec(s) || (LABEL.test(s) && [, s, segs[++seg] || '']);
    if (label) {
      const firm = FIRM.test(label[1]), value = tidy(firm ? label[2].split(/,\s/)[0] : label[2]); // "Infosys Limited, Pune"
      if (value) out.push({ text: value, kind: firm ? 'org' : 'title', line, seg, label: true });
      continue;
    }
    const at = AT.exec(s);
    if (at && at[1].split(' ').length <= 6) { out.push({ text: tidy(at[1]), kind: 'title', line, seg, with: tidy(at[2].split(/\s*,\s*/)[0]) }); continue; }
    const subs = s.split(/\s*,\s*/).map(tidy).filter(Boolean);
    if (isPlace(subs[0]) && subs.every((sub) => isPlace(sub) || /^[A-Z]{2,3}$/.test(sub))) continue; // "Leeds, UK", "San Francisco, CA"
    subs.forEach((sub, k) => {
      const prev = out[out.length - 1];
      const before = prev && prev.line === line && prev.seg === seg && prev.sub === k - 1 ? prev : null; // what this follows after a comma
      if (SUFFIX.test(sub)) { if (before?.kind === 'org') { before.text += `, ${sub}`; before.sub = k; } return; }
      // After the first piece, a known place, a state or country code, or the town in front of one, is where the job was.
      const place = k > 0 && (isPlace(sub) || /^[A-Z]{2}$/.test(sub));
      if (place && before?.kind === 'org') {
        // "Acme, Springfield, IL": the piece before the place is its town, unless it follows the title ("Director, Acme, UK").
        const town = out[out.length - 2];
        if (k > 1 && town?.kind === 'org' && town.seg === seg && town.sub === k - 2) out.pop();
        else if (k === 1 && subs.length === 2 && !isPlace(sub)) before.town = true; // "Armonk, NY" on its own may be only where the job was
      }
      if (place || WORK_TYPE.test(sub) || SUBHEADING.test(sub)) return;
      if (DEPARTMENT.test(sub)) { if (prev?.kind === 'title' && prev.line === line && !prev.with) { prev.text += `, ${sub}`; if (before) prev.sub = k; } return; }
      if (isTitle(sub) && before?.kind === 'title' && !before.with) { before.text += `, ${sub}`; before.sub = k; } // "Director, Product Marketing"
      else out.push({ text: sub, kind: isTitle(sub) ? 'title' : 'org', line, seg, sub: k });
    });
  }
  return out.filter((p) => p.text.length >= 2 && (p.kind === 'title' ? p.text.split(' ').length <= 8 : p.label || orgLike(p.text)));
}

/** Title and company of the first job listed under a heading such as "Experience". */
function firstRole(lines, heading) {
  const entry = [];
  let skipped = 0, dates = false, datedLine = false;
  for (let i = heading + 1; i < lines.length && entry.length < 3; i++) {
    const { text, heading: isHeading } = lines[i];
    if (isHeading) break;
    const prose = !LABEL_FIRST.test(text) && isProse(text), found = prose ? [] : pieces(text, entry.length), dated = text.search(DATES) >= 0;
    if (found.length) {
      // A job has one set of dates. A second line that carries dates, or a third line once the dates have gone by,
      // belongs to the job before: its title must not be taken for this one's.
      if (dated ? datedLine : dates && entry.length >= 2) break;
      entry.push(found.map((p) => ({ ...p, row: i })));
      datedLine ||= dated;
    }
    // Words that are neither a title nor an employer are description too ("Refonte du parcours d'achat mobile").
    else if ((prose || tidy(text.replace(DATES, '$1 ')).split(/\s+/).filter((w) => /^\p{Ll}/u.test(w)).length >= 3)
      && (entry.length || ++skipped > 2)) break; // the description of the job, or no list of jobs at all
    dates ||= dated;
  }
  const all = entry.flat();
  const title = all.find((p) => p.kind === 'title');
  if (!title) {
    // No recognisable job word: "Barista" above "Costa Coffee Ltd" still reads as title and employer.
    const firm = all.find((p) => p.kind === 'org' && COMPANY_WORDS.test(p.text));
    const other = firm && all.filter((p) => p !== firm && Math.abs(p.line - firm.line) === 1 && p.text.split(' ').length <= 4);
    return firm && other.length === 1 && entry[other[0].line].length === 1 ? { title: other[0].text, company: firm.text } : {};
  }
  if (title.with) return { title: title.text, company: title.with };
  // Where the employer is looked for, in order: on the lines above the title, starting where the entry starts
  // ("Acme, Chicago" then the title), in another column of the title's line, on the line straight below. What follows the title after a comma comes
  // after those unless it is plainly a company ("Engineer, Acme Corp"): with the employer on a line of its own,
  // "Vice President, Capital Markets" names a department. Last, a line further down, past the dates
  // ("Finance Director", "2020 – Present", "Varsity Freight").
  const k = all.indexOf(title), orgs = all.filter((p) => p.kind === 'org');
  const beside = orgs.filter((p) => p.line === title.line), apart = beside.filter((p) => p.seg !== title.seg), joined = beside.filter((p) => p.seg === title.seg);
  const below = all.some((p) => p.kind === 'title' && p.line === title.line + 1) ? [] : orgs.filter((p) => p.line === title.line + 1);
  const ranked = [
    ...orgs.filter((p) => p.line < title.line),
    ...apart.filter((p) => all.indexOf(p) > k), ...apart.filter((p) => all.indexOf(p) < k).reverse(),
    ...joined.filter((p) => COMPANY_WORDS.test(p.text)),
    ...below.filter((p) => p.row === title.row + 1),
    ...joined,
    ...below,
  ];
  const company = ranked.find((p) => !p.town) || ranked[0]; // "Armonk, NY" may be only where the job was
  return { title: title.text, company: company?.text };
}

const RUNS_ON = new RegExp(`(?:-|–|—|to|until|till|bis|au|à|→)\\s*${UNTIL}(?![\\p{L}\\d])|(?:^|[^\\p{L}])(?:since|seit|depuis|desde|ab)\\s+${DATE}`, 'iu');
const ENDED = /(?:19|20)\d{2}\D{1,12}(?:19|20)\d{2}/;
/**
 * For a list of jobs under `heading` whose first dates have an end and a later line runs to the present: the line
 * above that later one when it holds a job title itself (so firstRole can start there), else -1. Undefined for
 * the usual newest-first list.
 */
function currentWhenOldestFirst(lines, heading) {
  let first = true;
  for (let i = heading + 1; i < lines.length && !lines[i].heading; i++) {
    const { text } = lines[i];
    if (text.search(DATES) < 0) continue;
    const runsOn = RUNS_ON.test(text);
    if (first) { if (runsOn || !ENDED.test(text)) return undefined; first = false; continue; }
    if (runsOn) return pieces(text, 0).some((p) => p.kind === 'title') ? i - 1 : -1;
  }
  return undefined;
}

/**
 * @param {string} text
 * @param {{lines?: {size?:number,page?:number,footer?:boolean}[], links?: string[], filename?: string}} [hints] what
 *   the file itself adds: each line's font size and page (PDF) or whether it is a page footer (Word), the addresses
 *   its links point to, and its name.
 * @returns {{name?:string,email?:string,phone?:string,linkedin?:string,location?:string,current_title?:string,current_company?:string}}
 */
export function parseResume(text, hints = {}) {
  const out = {};
  const lines = readLines(text, hints.lines);
  if (!lines.length) return out;

  const email = findEmail(lines);
  if (email) out.email = email.value;
  const linkedin = findLinkedin(lines, hints.links);
  if (linkedin) out.linkedin = linkedin;
  const name = findName(lines, out.email, hints, Boolean(email || linkedin || findPhone(lines, () => true)));
  if (name) out.name = name.name;

  // The contact block: the lines above the first heading, a "Contact" section, and the few lines under the name
  // or around the email address (in a two-column layout these can sit anywhere in the text).
  const firstHeading = lines.findIndex((l) => l.heading);
  const near = (anchor, before, after) => (i) => anchor != null && i >= anchor - before && i <= anchor + after
    && !lines.slice(Math.min(i, anchor), Math.max(i, anchor) + 1).some((l) => l.heading);
  const underName = near(name?.line, 0, 4), byEmail = near(email?.line, 2, 2);
  const inContact = (i) => lines[i].section === 'contact' || (lines[i].section === 'head' && i < Math.min(firstHeading < 0 ? 12 : firstHeading, 15)) || underName(i) || byEmail(i);

  const phone = findPhone(lines, inContact);
  if (phone) out.phone = phone;
  const strong = (i) => lines[i].section === 'contact' || /@|linkedin\.com|https?:|www\./i.test(lines[i].text) || Boolean(phone && lines[i].text.includes(phone));
  const location = findLocation(lines, inContact, strong, out.name, out.email ? wordsOf(out.email.split('@')[0]) : []);
  if (location) out.location = location;

  // Current role: the first entry under an "Experience" heading. Where the list runs oldest first, the entry that
  // runs to the present when it stands on one line, and otherwise nothing: the first entry is a job long left.
  for (let i = 0; i < lines.length && !out.current_title; i++) {
    if (!lines[i].heading || lines[i].section !== 'experience') continue;
    const current = currentWhenOldestFirst(lines, i);
    if (current === -1) break;
    const role = firstRole(lines, current ?? i);
    if (role.title) { out.current_title = role.title; if (role.company) out.current_company = role.company; }
  }
  // Otherwise a headline under the name ("Senior Product Designer at Juniper Row") is a fair guess.
  if (!out.current_title && name) {
    for (let i = name.line; i <= name.line + 3 && i < lines.length && !out.current_title; i++) {
      if (i > name.line && lines[i].heading) break;
      for (const part of lines[i].parts.flatMap((p) => p.split(DASH))) {
        if (part.length > 70 || /[@\d]/.test(part) || !isTitle(part) || plain(part).includes(plain(out.name))) continue;
        if (/^(?:former(?:ly)?|ex|aspiring|seeking|future|retired|previously)\b/i.test(part)) continue; // what the person was, or hopes to be
        // "Seeking a Sales Manager position" mentions a title; a headline is one, written as a heading.
        if (part.split(' ').some((w) => /^\p{Ll}/u.test(w) && !/^(?:of|and|at|in|for|the|to|de|du|des|la|le|di|y|e|bei|und|chez)$/.test(w))) continue;
        const at = AT.exec(part);
        out.current_title = tidy(at ? at[1] : part);
        if (at) out.current_company = tidy(at[2].split(/\s*,\s*/)[0]);
        break;
      }
    }
  }
  for (const k of ['current_title', 'current_company']) if (out[k] && (out[k].length > 80 || out[k].length < 2 || !/\p{L}/u.test(out[k]))) delete out[k];
  return out;
}

/** A person's name taken from a file name such as "Raphael Rivero - Resume__112026.pdf", or '' if it does not hold one. */
export function nameFromFilename(filename) {
  const base = filename.replace(/\.[^.]+$/, '').replace(/_+/g, ' ')
    .replace(/\b(resume|résumé|cv|curriculum vitae|lebenslauf|bewerbung|curr[ií]culum|curr[ií]culo|hoja de vida|cover letter|final|updated|latest|new|copy|draft|v\d+)\b/gi, ' ').replace(/[\d()[\]]+/g, ' ');
  const part = base.split(/\s+[-–—|]\s+|\s{2,}/).map((p) => p.replace(/^[\s-]+|[\s-]+$/g, '')).find((p) => {
    const words = p.split(' ');
    // The shape of a name, and none of the words files are called by ("Untitled document", "Black White Minimalist").
    return words.length >= 2 && words.length <= 4 && /^[\p{L}][\p{L} .'’-]+$/u.test(p) && !TITLE_WORDS.test(p)
      && words.every((w) => /^\p{Lu}?\p{Ll}[\p{L}'’]*\.?$|^\p{Lu}{2,}$/u.test(w) && !NEVER_NAME.has(lettersOf(w)) && !FILE_WORDS.has(lettersOf(w)) && !LANGUAGES.has(lettersOf(w)));
  });
  if (!part) return '';
  return part === part.toLowerCase() || part === part.toUpperCase() ? titleCase(part) : part;
}

/**
 * Read a résumé file and return what could be found, with the reason when little or nothing could be:
 * 'ok', 'no_text' (a PDF that is a scan or image with no selectable text), 'blank' (another kind of file with no
 * text in it), 'empty' (no bytes at all), 'binary' (not text under a text name), 'unreadable' (old .doc and
 * similar), 'protected' (password-protected) or 'error'. With the last two comes `error`, what was thrown: the caller can
 * tell a document that will not open from a part of the app that failed to load.
 */
export async function readResume(file) {
  let text = '', layout = {}, status = 'ok', error, binary = false;
  try {
    if (file.size !== 0) ({ text, layout = {}, binary = false } = await readFile(file));
    // Why there is nothing to read: the file is empty, is not text at all, is a scan (PDF), or is of a kind this cannot open.
    if (file.size === 0) status = 'empty';
    else if (binary) status = 'binary';
    else if (!text.trim()) status = !/\.(pdf|docx|rtf|txt)$/i.test(file.name) ? 'unreadable' : layout.lines && 'links' in layout ? 'no_text' : 'blank';
  } catch (err) {
    console.warn('The résumé could not be read automatically:', err);
    status = /password/i.test(`${err?.name} ${err?.message}`) ? 'protected' : 'error';
    error = err;
  }
  const fields = parseResume(text, { ...layout, filename: file.name });
  let nameFromFile = false;
  if (!fields.name) {
    const guess = nameFromFilename(file.name);
    if (guess) { fields.name = guess; nameFromFile = true; }
  }
  return error === undefined ? { fields, status, nameFromFile } : { fields, status, nameFromFile, error };
}
