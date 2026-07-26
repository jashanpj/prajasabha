// Issue #24 (B1 — Raise an Issue form). Byte-level EXIF removal for the
// two photo formats the upload endpoint accepts. Deliberately a hand-rolled
// marker/chunk walker with no image-decode dependency: it never inflates
// pixel data, so it runs unmodified (and cheaply) inside a Cloudflare
// Worker. Evidence photos routinely carry GPS coordinates of a
// contributor's home — stripping location metadata before bytes ever reach
// R2 is a privacy control in the same spirit as the vault join rule
// (CLAUDE.md invariant 1), not an image-processing nicety.
//
// Behavior:
// - image/jpeg: removes every APP1 (0xFFE1) segment — the segment EXIF
//   (and its GPS IFD) lives in. All other bytes pass through untouched.
// - image/png: removes every `eXIf` ancillary chunk. All other chunks pass
//   through untouched (CRCs included — untouched chunks keep their bytes).
// - anything else: THROWS. An endpoint that believes it stripped EXIF but
//   silently didn't is a worse failure mode than one that errors loudly —
//   the same fail-loud posture as packages/shared/src/config.ts.

/** Strips EXIF metadata from `bytes` in-memory; returns a new Uint8Array. */
export function stripExif(bytes: Uint8Array, mimeType: string): Uint8Array {
  switch (mimeType) {
    case "image/jpeg":
      return stripJpegApp1(bytes);
    case "image/png":
      return stripPngExifChunks(bytes);
    default:
      throw new Error(
        `stripExif: unsupported mimeType "${mimeType}" — refusing to pass bytes through unstripped`,
      );
  }
}

function malformed(format: string, detail: string): Error {
  return new Error(`stripExif: malformed ${format} — ${detail}`);
}

/**
 * Walks JPEG marker segments from SOI, dropping APP1 segments and copying
 * everything else verbatim. Once SOS (start of scan) is reached, the rest
 * of the file — entropy-coded scan data through EOI — is copied unparsed:
 * EXIF can only appear in the pre-scan segment area.
 */
function stripJpegApp1(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw malformed("JPEG", "missing SOI marker");
  }

  const kept: number[] = [0xff, 0xd8];
  let i = 2;

  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw malformed("JPEG", `expected marker at byte ${i}`);
    const marker = bytes[i + 1];
    if (marker === undefined) throw malformed("JPEG", "truncated marker");

    // SOS: copy the remainder (scan data + EOI) verbatim and stop parsing.
    if (marker === 0xda) {
      for (let j = i; j < bytes.length; j++) kept.push(bytes[j] as number);
      return new Uint8Array(kept);
    }

    // EOI, or standalone markers (TEM, RST0-7) — no length field.
    if (marker === 0xd9) {
      kept.push(0xff, 0xd9);
      return new Uint8Array(kept);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(0xff, marker);
      i += 2;
      continue;
    }

    // Length-carrying segment: length field includes its own 2 bytes.
    const lengthHi = bytes[i + 2];
    const lengthLo = bytes[i + 3];
    if (lengthHi === undefined || lengthLo === undefined) {
      throw malformed("JPEG", "truncated segment length");
    }
    const segmentTotal = 2 + ((lengthHi << 8) | lengthLo);
    if (i + segmentTotal > bytes.length) throw malformed("JPEG", "segment overruns file");

    if (marker !== 0xe1) {
      for (let j = i; j < i + segmentTotal; j++) kept.push(bytes[j] as number);
    }
    i += segmentTotal;
  }

  throw malformed("JPEG", "ended without SOS or EOI");
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Walks PNG chunks after the 8-byte signature, dropping `eXIf` chunks
 * (which carry a raw TIFF/Exif payload) and copying every other chunk —
 * length, type, data, and CRC — verbatim.
 */
function stripPngExifChunks(bytes: Uint8Array): Uint8Array {
  if (bytes.length < PNG_SIGNATURE.length) throw malformed("PNG", "shorter than signature");
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw malformed("PNG", "bad signature");
  }

  const kept: number[] = [...PNG_SIGNATURE];
  let i = PNG_SIGNATURE.length;

  while (i < bytes.length) {
    if (i + 8 > bytes.length) throw malformed("PNG", "truncated chunk header");
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1] as number;
    const b2 = bytes[i + 2] as number;
    const b3 = bytes[i + 3] as number;
    const dataLength = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
    const chunkTotal = 4 + 4 + dataLength + 4; // length + type + data + CRC
    if (i + chunkTotal > bytes.length) throw malformed("PNG", "chunk overruns file");

    const type = String.fromCharCode(
      bytes[i + 4] as number,
      bytes[i + 5] as number,
      bytes[i + 6] as number,
      bytes[i + 7] as number,
    );

    if (type !== "eXIf") {
      for (let j = i; j < i + chunkTotal; j++) kept.push(bytes[j] as number);
    }
    i += chunkTotal;

    if (type === "IEND") break;
  }

  return new Uint8Array(kept);
}
