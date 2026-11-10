// Copies the fonts and character maps the PDF viewer needs into public/pdfjs, so they are served from this site
// (the content security policy does not allow loading them from anywhere else). Runs before every build.
import fs from 'node:fs';
import path from 'node:path';

const from = path.resolve('node_modules/pdfjs-dist');
const to = path.resolve('public/pdfjs');
for (const dir of ['standard_fonts', 'cmaps']) {
  fs.rmSync(path.join(to, dir), { recursive: true, force: true });
  fs.cpSync(path.join(from, dir), path.join(to, dir), { recursive: true });
}
console.log('Copied PDF viewer fonts and character maps into public/pdfjs');
