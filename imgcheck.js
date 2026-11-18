// Local checks on photos (nothing is sent anywhere):
// - EXIF of JPEG files: when the photo was taken, camera, and the editing app if one saved it;
// - a 64-bit "difference hash" so the same photo re-sent cropped, resized or recompressed is recognised.

const ASCII = new TextDecoder("latin1");

/** Reads a few EXIF tags from a JPEG. Returns null when there are none (screenshots, messaging apps, HEIC…). */
export async function readExif(blob) {
  const buf = new DataView(await blob.slice(0, 256 * 1024).arrayBuffer());
  if (buf.byteLength < 4 || buf.getUint16(0) !== 0xffd8) return null;
  let p = 2;
  while (p + 4 <= buf.byteLength) {
    if (buf.getUint8(p) !== 0xff) return null;
    const marker = buf.getUint8(p + 1);
    const len = buf.getUint16(p + 2);
    if (marker === 0xda || marker === 0xd9) return null; // image data starts: no EXIF
    if (marker === 0xe1 && p + 10 <= buf.byteLength && ASCII.decode(new Uint8Array(buf.buffer, p + 4, 4)) === "Exif") {
      try { return parseTiff(buf, p + 10); } catch { return null; }
    }
    p += 2 + len;
  }
  return null;
}

function parseTiff(v, start) {
  const little = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, little);
  const u32 = (o) => v.getUint32(start + o, little);
  const str = (o, n) => {
    const at = n > 4 ? u32(o) : o;
    if (start + at + n > v.byteLength) return null;
    return ASCII.decode(new Uint8Array(v.buffer, start + at, n)).replace(/\0+$/, "").trim() || null;
  };
  const readIfd = (off, want) => {
    const out = {};
    if (!off || start + off + 2 > v.byteLength) return out;
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (start + e + 12 > v.byteLength) break;
      const tag = u16(e);
      const name = want[tag];
      if (!name) continue;
      const type = u16(e + 2);
      const count = u32(e + 4);
      out[name] = type === 2 ? str(e + 8, count) : type === 4 ? u32(e + 8) : type === 3 ? u16(e + 8) : null;
    }
    return out;
  };
  const ifd0 = readIfd(u32(4), { 0x010f: "make", 0x0110: "model", 0x0131: "software", 0x0132: "modified", 0x8769: "exifPtr" });
  const exif = readIfd(ifd0.exifPtr, { 0x9003: "taken", 0x9004: "digitized", 0x9011: "offset" });
  const iso = (s) => (s && /^\d{4}:\d\d:\d\d \d\d:\d\d/.test(s) ? `${s.slice(0, 10).replace(/:/g, "-")}T${s.slice(11, 16)}` : null);
  const out = {
    taken: iso(exif.taken) || iso(exif.digitized),
    modified: iso(ifd0.modified),
    offset: exif.offset || null,
    make: ifd0.make || null,
    model: ifd0.model || null,
    software: ifd0.software || null,
  };
  return Object.values(out).some(Boolean) ? out : null;
}

/**
 * 256-bit difference hash (hex) of the upright picture. 16×16 rather than the usual 8×8 because
 * receipts all look alike at low resolution (a pale rectangle); the extra detail tells them apart.
 */
export async function dHash(blob) {
  const N = 16;
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const c = document.createElement("canvas");
  c.width = N + 1;
  c.height = N;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, N + 1, N);
  bmp.close?.();
  const d = ctx.getImageData(0, 0, N + 1, N).data;
  const g = (x, y) => { const i = (y * (N + 1) + x) * 4; return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; };
  let hex = "";
  for (let y = 0; y < N; y++) {
    for (let x0 = 0; x0 < N; x0 += 8) {
      let byte = 0;
      for (let x = x0; x < x0 + 8; x++) byte = (byte << 1) | (g(x, y) > g(x + 1, y) ? 1 : 0);
      hex += byte.toString(16).padStart(2, "0");
    }
  }
  return hex;
}

/** Number of differing bits between two hashes (0 = same picture). */
export function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) { n += x & 1; x >>= 1; }
  }
  return n;
}

/** Apps that retouch pictures. A phone's own camera or OS version ("17.1", "Android…") is not listed. */
export const EDITOR_RE = /photoshop|lightroom|snapseed|picsart|gimp|pixelmator|facetune|canva|affinity|paint\.net|fotor|polarr|photopea|meitu|airbrush|retouch|photo ?editor|picmonkey|befunky|photodirector|inshot|ibis|procreate/i;
