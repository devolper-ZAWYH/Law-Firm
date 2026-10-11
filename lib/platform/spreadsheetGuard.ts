/**
 * Decompression-bomb guard for uploaded spreadsheets.
 *
 * An .xlsx file is a ZIP container. The upload route caps the COMPRESSED size at
 * 5 MB, which bounds nothing about what that unzips to: a few MB of repetitive
 * sheet XML expands to gigabytes, and XLSX.read materialises all of it in the
 * single Node process that serves every other request. One HTTP request from
 * the employee designated to upload the attendance sheet was enough to OOM the
 * portal.
 *
 * Rather than trusting the parser, read the ZIP's own central directory first —
 * it declares each entry's uncompressed size — and refuse anything that claims
 * to expand beyond a sane ceiling. This is cheap (a few hundred bytes of header
 * parsing, no decompression) and happens before a single byte is inflated.
 *
 * NOT a ZIP (a legacy .xls, which is an OLE2/CFB file) → skipped. That format is
 * uncompressed, so its expansion is already bounded by the upload size cap.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** Fixed part of an End Of Central Directory record. */
const EOCD_SIZE = 22;
/** Fixed part of a central-directory file header. */
const CENTRAL_HEADER_SIZE = 46;
/** A ZIP comment can push the EOCD this far from the end of the file. */
const MAX_ZIP_COMMENT = 0xffff;
/** Sentinel meaning "the real value lives in a ZIP64 extra field". */
const ZIP64_SENTINEL = 0xffffffff;

export interface EnvelopeLimits {
  /** Total declared uncompressed bytes across all entries. */
  maxTotalUncompressedBytes: number;
  /** Number of files inside the container. */
  maxEntries: number;
}

/**
 * A ZKTeco monthly time card for a whole firm is a few hundred KB uncompressed;
 * 64 MB leaves ~300x headroom while keeping peak memory far below what would
 * threaten the process.
 */
export const DEFAULT_ENVELOPE_LIMITS: EnvelopeLimits = {
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  maxEntries: 1024,
};

/** Thrown with a message that is safe to show the uploader. */
export class UnsafeSpreadsheetError extends Error {}

function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_HEADER_SIGNATURE;
}

/** Scan backwards for the End Of Central Directory record. */
function findEocdOffset(buffer: Buffer): number | null {
  const earliest = Math.max(0, buffer.length - (EOCD_SIZE + MAX_ZIP_COMMENT));
  for (let i = buffer.length - EOCD_SIZE; i >= earliest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return null;
}

/**
 * Throw if `buffer` is a ZIP that declares an implausible amount of content.
 * Returns the total declared uncompressed size for a container that passes.
 */
export function assertSafeSpreadsheetEnvelope(
  buffer: Buffer,
  limits: EnvelopeLimits = DEFAULT_ENVELOPE_LIMITS
): number {
  if (!looksLikeZip(buffer)) return 0; // legacy .xls — nothing to expand

  const eocd = findEocdOffset(buffer);
  if (eocd === null) {
    throw new UnsafeSpreadsheetError('The file is not a readable spreadsheet.');
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (entryCount > limits.maxEntries) {
    throw new UnsafeSpreadsheetError('The file contains too many parts to be a time card.');
  }
  if (centralOffset >= buffer.length) {
    throw new UnsafeSpreadsheetError('The file is not a readable spreadsheet.');
  }

  let cursor = centralOffset;
  let totalUncompressed = 0;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + CENTRAL_HEADER_SIZE > buffer.length) {
      throw new UnsafeSpreadsheetError('The file is not a readable spreadsheet.');
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      throw new UnsafeSpreadsheetError('The file is not a readable spreadsheet.');
    }

    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);

    // ZIP64 moves the real sizes into an extra field, so the 32-bit values here
    // stop being trustworthy. A time-card export is never this large; refuse
    // rather than parse a container whose true size we cannot read cheaply.
    if (uncompressedSize === ZIP64_SENTINEL || compressedSize === ZIP64_SENTINEL) {
      throw new UnsafeSpreadsheetError('The file is too large to process.');
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw new UnsafeSpreadsheetError('The file is too large to process.');
    }

    cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  }

  return totalUncompressed;
}
