// Minimal ICO reading and writing, for swapping hand-tuned small sizes into the icon that
// `tauri icon` generates (scripts/icons.ts). Entries are kept as PNG data, which Windows has
// accepted at every size since Vista.

export type IcoImage = { size: number; data: Buffer };

/** The images in an ICO file (square images only; size 256 is stored as 0). */
export function readIco(buf: Buffer): IcoImage[] {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("not an ICO file");
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const e = 6 + i * 16;
    const width = buf[e] || 256;
    const length = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    return { size: width, data: buf.subarray(offset, offset + length) };
  });
}

/** An ICO file holding `images` (PNG data), smallest first. */
export function writeIco(images: IcoImage[]): Buffer {
  const sorted = [...images].sort((a, b) => a.size - b.size);
  const header = Buffer.alloc(6 + 16 * sorted.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sorted.length, 4);
  let offset = header.length;
  sorted.forEach((img, i) => {
    if (img.size < 1 || img.size > 256) throw new Error(`icon size ${img.size} out of range`);
    const e = 6 + i * 16;
    header[e] = img.size === 256 ? 0 : img.size;
    header[e + 1] = img.size === 256 ? 0 : img.size;
    header[e + 2] = 0; // palette colours
    header[e + 3] = 0; // reserved
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(img.data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([header, ...sorted.map((i) => i.data)]);
}

/** `images` with the sizes in `replacements` swapped (or added). */
export function replaceSizes(images: IcoImage[], replacements: IcoImage[]): IcoImage[] {
  const bySize = new Map(images.map((i) => [i.size, i]));
  for (const r of replacements) bySize.set(r.size, r);
  return [...bySize.values()].sort((a, b) => a.size - b.size);
}
