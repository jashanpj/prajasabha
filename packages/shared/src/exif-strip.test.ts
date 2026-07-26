import { describe, expect, it } from "vitest";
import { stripExif } from "./exif-strip";

// Issue #24 (B1 — Raise an Issue form). stripExif(bytes, mimeType) is a
// hand-rolled, byte-level marker/chunk walker (JPEG APP1/EXIF segment
// removal, PNG eXIf ancillary chunk removal) — no image-decode dependency,
// so it runs unmodified in Cloudflare Workers (see the approved plan's
// step 1). This is the exact case #24's test notes call out: "EXIF-strip
// verified on an uploaded fixture image with GPS data."
//
// Fixtures are built byte-literally right here rather than loaded from a
// binary file, per the plan/test-notes. All offsets below are hand-computed
// and commented so the fixture stays auditable.

// ---- tiny byte-packing helpers (big-endian for JPEG/PNG segment/chunk
// length fields, little-endian for the TIFF/Exif payload's "II" byte order) ----
function u16be(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}
function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function u16le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/**
 * A minimal, little-endian ("II") TIFF/Exif payload carrying one IFD0 entry
 * (a pointer to a GPS IFD) and a GPS IFD with GPSLatitudeRef + GPSLatitude
 * — a real, spec-shaped GPS tag, not a placeholder. Offsets are computed
 * inline (not hardcoded) so the fixture stays correct if a value changes.
 *
 * Layout (offsets relative to the TIFF header's own byte 0):
 *   0..7   TIFF header: "II", magic 42, IFD0 offset (=8)
 *   8..25  IFD0: 1 entry (tag 0x8825 GPSInfo -> offset 26), next-IFD=0
 *   26..55 GPS IFD: 2 entries (GPSLatitudeRef, GPSLatitude -> offset 56), next-IFD=0
 *   56..79 GPS IFD external data: 3 RATIONALs (degrees/minutes/seconds)
 */
function buildExifTiffPayload(): number[] {
  const bytes: number[] = [];

  // TIFF header (offset 0): byte order "II" (little-endian), magic 0x2A,
  // IFD0 offset = 8 (immediately after this 8-byte header).
  bytes.push(0x49, 0x49, 0x2a, 0x00, ...u32le(8));

  // IFD0 (offset 8): 1 entry -> GPS IFD pointer (tag 0x8825 GPSInfo, type
  // 4 = LONG, count 1, value = offset to the GPS IFD below).
  const gpsIfdOffset = 8 + 2 + 12 + 4; // = 26 (count + 1 entry + next-IFD ptr)
  bytes.push(...u16le(1));
  bytes.push(...u16le(0x8825), ...u16le(4), ...u32le(1), ...u32le(gpsIfdOffset));
  bytes.push(...u32le(0)); // no next IFD

  // GPS IFD (offset 26): 2 entries, ascending tag order per the TIFF spec.
  //   tag 0x0001 GPSLatitudeRef, type 2 = ASCII, count 2 ("N\0") — fits
  //   inline in the 4-byte value field.
  //   tag 0x0002 GPSLatitude, type 5 = RATIONAL, count 3 — 24 bytes, does
  //   NOT fit inline, so the value field is an offset to external data.
  const gpsDataOffset = gpsIfdOffset + 2 + 12 * 2 + 4; // = 56
  bytes.push(...u16le(2));
  bytes.push(...u16le(0x0001), ...u16le(2), ...u32le(2), 0x4e, 0x00, 0x00, 0x00);
  bytes.push(...u16le(0x0002), ...u16le(5), ...u32le(3), ...u32le(gpsDataOffset));
  bytes.push(...u32le(0)); // no next IFD

  // GPS IFD external data (offset 56): degrees=12/1, minutes=34/1,
  // seconds=5678/100 — a real (if fictitious) GPS fix, not zeros.
  bytes.push(...u32le(12), ...u32le(1));
  bytes.push(...u32le(34), ...u32le(1));
  bytes.push(...u32le(5678), ...u32le(100));

  return bytes; // 80 bytes total
}

/** A full JPEG APP1 segment (marker + length + "Exif\0\0" + TIFF payload). */
function buildApp1ExifSegment(): number[] {
  const tiff = buildExifTiffPayload();
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0"
  const length = 2 + payload.length; // JPEG segment length includes itself
  return [0xff, 0xe1, ...u16be(length), ...payload];
}

// A minimal-but-structurally-valid SOS header (1 component, no huffman
// tables needed for marker-walking purposes) + 4 bytes of fake
// entropy-coded scan data (deliberately no 0xFF bytes, so it can't be
// mistaken for another marker) + EOI.
const SOS_AND_SCAN_AND_EOI = [
  0xff,
  0xda,
  ...u16be(8),
  0x01,
  0x01,
  0x00,
  0x00,
  0x3f,
  0x00, // minimal SOS header (Ns=1, component 1, Ss/Se/AhAl)
  0x01,
  0x02,
  0x03,
  0x04, // fake scan data
  0xff,
  0xd9, // EOI
];

function buildJpegWithGpsExif(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...buildApp1ExifSegment(), ...SOS_AND_SCAN_AND_EOI]);
}

function buildJpegWithoutApp1(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...SOS_AND_SCAN_AND_EOI]);
}

// ---- PNG fixture: signature + IHDR + (eXIf) + IDAT + IEND ----

function crc32(bytes: number[]): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: number[]): number[] {
  const typeBytes = Array.from(type).map((c) => c.charCodeAt(0));
  const crc = crc32([...typeBytes, ...data]);
  return [...u32be(data.length), ...typeBytes, ...data, ...u32be(crc)];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_1X1_RGBA = [...u32be(1), ...u32be(1), 8, 6, 0, 0, 0]; // width, height, bit depth, color type, compression, filter, interlace

function buildPngWithExifChunk(): Uint8Array {
  const ihdr = pngChunk("IHDR", IHDR_1X1_RGBA);
  // PNG's eXIf chunk carries the raw TIFF-format Exif payload directly, with
  // no "Exif\0\0" prefix (that prefix is a JPEG APP1 convention, not PNG's).
  const exif = pngChunk("eXIf", buildExifTiffPayload());
  const idat = pngChunk("IDAT", []);
  const iend = pngChunk("IEND", []);
  return new Uint8Array([...PNG_SIGNATURE, ...ihdr, ...exif, ...idat, ...iend]);
}

function buildPngWithoutExifChunk(): Uint8Array {
  const ihdr = pngChunk("IHDR", IHDR_1X1_RGBA);
  const idat = pngChunk("IDAT", []);
  const iend = pngChunk("IEND", []);
  return new Uint8Array([...PNG_SIGNATURE, ...ihdr, ...idat, ...iend]);
}

function containsMarker(bytes: Uint8Array, a: number, b: number): boolean {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === a && bytes[i + 1] === b) return true;
  }
  return false;
}

describe("stripExif — JPEG (APP1/EXIF segment removal)", () => {
  it("removes the APP1 marker entirely from a JPEG with GPS EXIF", () => {
    const input = buildJpegWithGpsExif();
    const output = stripExif(input, "image/jpeg");
    expect(containsMarker(output, 0xff, 0xe1)).toBe(false);
  });

  it("shortens the output by exactly the APP1 segment's length", () => {
    const input = buildJpegWithGpsExif();
    const app1Length = buildApp1ExifSegment().length;
    const output = stripExif(input, "image/jpeg");
    expect(output.length).toBe(input.length - app1Length);
  });

  it("leaves non-EXIF bytes (SOI, scan data, EOI) byte-identical", () => {
    const input = buildJpegWithGpsExif();
    const output = stripExif(input, "image/jpeg");
    const expectedRemainder = new Uint8Array([0xff, 0xd8, ...SOS_AND_SCAN_AND_EOI]);
    expect(Array.from(output)).toEqual(Array.from(expectedRemainder));
  });

  it("passes a JPEG with no APP1 segment through unchanged", () => {
    const input = buildJpegWithoutApp1();
    const output = stripExif(input, "image/jpeg");
    expect(Array.from(output)).toEqual(Array.from(input));
  });
});

describe("stripExif — PNG (eXIf ancillary chunk removal)", () => {
  it("removes the eXIf chunk from a PNG carrying one, leaving other chunks byte-identical", () => {
    const input = buildPngWithExifChunk();
    const output = stripExif(input, "image/png");

    const outputAscii = Buffer.from(output).toString("latin1");
    expect(outputAscii).not.toContain("eXIf");

    const expected = buildPngWithoutExifChunk();
    expect(Array.from(output)).toEqual(Array.from(expected));
  });

  it("passes a PNG with no eXIf chunk through unchanged", () => {
    const input = buildPngWithoutExifChunk();
    const output = stripExif(input, "image/png");
    expect(Array.from(output)).toEqual(Array.from(input));
  });
});

describe("stripExif — unsupported mime types", () => {
  // Design choice (documented per the test brief): stripExif THROWS for a
  // mimeType it doesn't recognize, rather than silently passing the bytes
  // through unstripped. An endpoint that believes it stripped EXIF but
  // silently didn't is a worse failure mode than one that errors loudly —
  // consistent with this codebase's "no silent fallback" posture
  // (CLAUDE.md invariant 6 is about secrets specifically, but the same
  // fail-loud instinct applies here).
  it("throws for an unsupported mimeType instead of silently passing bytes through", () => {
    const input = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    expect(() => stripExif(input, "image/gif")).toThrow();
  });
});
