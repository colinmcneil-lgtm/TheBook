// Zips the extension/ folder into public/the-book-extension.zip so the workspace can offer it as a download
// (Settings, Browser extension). Runs before every build. No dependencies: a zip is simple enough to write by hand.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve('extension');
const out = path.resolve('public/the-book-extension.zip');

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (!entry.name.startsWith('.')) files.push(full);
  }
})(root);

const chunks = [], central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(path.relative(root, file).split(path.sep).join('/'));
  const data = fs.readFileSync(file);
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const crc = zlib.crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);      // local file header
  header.writeUInt16LE(20, 4);              // version needed
  header.writeUInt16LE(0x0800, 6);          // names are UTF-8
  header.writeUInt16LE(8, 8);               // deflate
  header.writeUInt16LE(0, 10);              // time (fixed, so the zip is identical for identical contents)
  header.writeUInt16LE(0x5821, 12);         // date: 2024-01-01
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(packed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);       // central directory entry
  entry.writeUInt16LE(20, 4);
  header.copy(entry, 6, 4, 30);             // same fields as the local header, from "version needed" on
  entry.writeUInt32LE(offset, 42);
  chunks.push(header, name, packed);
  central.push(entry, name);
  offset += header.length + name.length + packed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([...chunks, directory, end]));
console.log(`Packed ${files.length} extension files into ${path.relative(process.cwd(), out)}`);
