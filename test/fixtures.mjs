// Builds small résumé files in memory for the tests: a Word document with a page header and footer, links, list
// items and tab stops, and RTF or text files in a given encoding.
import { zipSync, strToU8 } from 'fflate';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const run = (text) => text.split('\t').map((piece) => `<w:r><w:t xml:space="preserve">${piece}</w:t></w:r>`).join('<w:r><w:tab/></w:r>');

/**
 * A .docx file. `header`, `body` and `footer` are lists of paragraphs: a string (XML entities are passed through as
 * written), { link, text } for a hyperlink whose address is not shown, or { bullet } for a list item, whose bullet
 * Word draws itself. `tabStops` adds tab stop settings to each paragraph.
 */
export function docx({ header, body = [], footer, tabStops = false }, name = 'resume.docx') {
  const files = {};
  // Each part of the file keeps the targets of its own links in a side file.
  const part = (path, paragraphs, wrap) => {
    const links = [];
    const xml = paragraphs.map((p) => {
      const settings = tabStops ? '<w:pPr><w:tabs><w:tab w:val="right" w:pos="9026"/><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' : '';
      if (typeof p === 'string') return `<w:p>${settings}${run(p)}</w:p>`;
      if (p.bullet) return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(p.bullet)}</w:p>`;
      links.push(p.link);
      return `<w:p>${settings}<w:hyperlink r:id="rId${links.length}" w:history="1">${run(p.text)}</w:hyperlink></w:p>`;
    }).join('');
    files[`word/${path}`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${wrap(xml)}`);
    files[`word/_rels/${path}.rels`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      links.map((target, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target.replace(/&/g, '&amp;')}" TargetMode="External"/>`).join('')}</Relationships>`);
  };
  // A text box is stored twice: once as a drawing and once as a fallback for older versions of Word.
  const textBox = '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:txbxContent><w:p><w:r><w:t>In a text box</w:t></w:r></w:p></w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent><w:p><w:r><w:t>In a text box</w:t></w:r></w:p></w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>';
  part('document.xml', body, (xml) => `<w:document ${W}><w:body>${xml}${tabStops ? textBox : ''}<w:sectPr/></w:body></w:document>`);
  if (header) part('header1.xml', header, (xml) => `<w:hdr ${W}>${xml}</w:hdr>`);
  if (footer) part('footer1.xml', footer, (xml) => `<w:ftr ${W}>${xml}</w:ftr>`);
  files['[Content_Types].xml'] = strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  return new File([zipSync(files)], name);
}

export const rtfFile = (rtf, name = 'resume.rtf') => new File([Buffer.from(rtf, 'latin1')], name);

/** A .txt file in 'utf16le' (with its byte order mark, as Notepad writes it) or 'latin1'. */
export const textFile = (text, encoding, name = 'resume.txt') =>
  new File([encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : Buffer.from(text, encoding)], name);
