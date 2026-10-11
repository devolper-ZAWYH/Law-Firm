import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENVELOPE_LIMITS,
  UnsafeSpreadsheetError,
  assertSafeSpreadsheetEnvelope,
} from '@/lib/platform/spreadsheetGuard';

/**
 * P1-5 regression suite — a 5 MB .xlsx upload could declare gigabytes of
 * content and OOM the single Node process during XLSX.read.
 *
 * These build ZIP central directories byte by byte, so the guard is tested
 * against the structure it actually parses rather than against a fixture.
 */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

interface Entry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

/** A minimal but structurally valid ZIP container. */
function buildZip(entries: Entry[], opts: { comment?: string } = {}): Buffer {
  // A local header just so the file starts with the ZIP magic number.
  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);

  const central = entries.map((entry) => {
    const name = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.uncompressedSize, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    name.copy(header, 46);
    return header;
  });

  const centralBytes = Buffer.concat(central);
  const comment = Buffer.from(opts.comment ?? '', 'utf8');
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(local.length, 16); // central directory offset
  eocd.writeUInt16LE(comment.length, 20);
  comment.copy(eocd, 22);

  return Buffer.concat([local, centralBytes, eocd]);
}

const realisticTimeCard = () =>
  buildZip([
    { name: '[Content_Types].xml', compressedSize: 400, uncompressedSize: 1_800 },
    { name: 'xl/worksheets/sheet1.xml', compressedSize: 22_000, uncompressedSize: 240_000 },
    { name: 'xl/sharedStrings.xml', compressedSize: 3_100, uncompressedSize: 18_000 },
  ]);

describe('assertSafeSpreadsheetEnvelope', () => {
  it('accepts a realistically sized time-card export', () => {
    expect(() => assertSafeSpreadsheetEnvelope(realisticTimeCard())).not.toThrow();
  });

  it('reports the total declared size for an accepted file', () => {
    expect(assertSafeSpreadsheetEnvelope(realisticTimeCard())).toBe(259_800);
  });

  it('refuses a single entry that expands past the ceiling', () => {
    // The bomb: tiny on the wire, 4 GB once inflated.
    const bomb = buildZip([
      { name: 'xl/worksheets/sheet1.xml', compressedSize: 4_200, uncompressedSize: 4_000_000_000 },
    ]);

    expect(() => assertSafeSpreadsheetEnvelope(bomb)).toThrow(UnsafeSpreadsheetError);
  });

  it('refuses entries that are individually fine but ruinous in aggregate', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `xl/worksheets/sheet${i}.xml`,
      compressedSize: 5_000,
      uncompressedSize: 8 * 1024 * 1024,
    }));

    expect(() => assertSafeSpreadsheetEnvelope(buildZip(many))).toThrow(
      UnsafeSpreadsheetError
    );
  });

  it('refuses a container with an absurd number of parts', () => {
    const entries = Array.from(
      { length: DEFAULT_ENVELOPE_LIMITS.maxEntries + 1 },
      (_, i) => ({ name: `f${i}`, compressedSize: 1, uncompressedSize: 1 })
    );

    expect(() => assertSafeSpreadsheetEnvelope(buildZip(entries))).toThrow(
      UnsafeSpreadsheetError
    );
  });

  it('refuses ZIP64, where the 32-bit sizes cannot be believed', () => {
    const zip64 = buildZip([
      { name: 'xl/worksheets/sheet1.xml', compressedSize: 0xffffffff, uncompressedSize: 0xffffffff },
    ]);

    expect(() => assertSafeSpreadsheetEnvelope(zip64)).toThrow(UnsafeSpreadsheetError);
  });

  it('still finds the directory when a ZIP comment pads the end', () => {
    // A bomb could otherwise hide behind a trailing comment.
    const padded = buildZip(
      [{ name: 'sheet1.xml', compressedSize: 100, uncompressedSize: 4_000_000_000 }],
      { comment: 'x'.repeat(1000) }
    );

    expect(() => assertSafeSpreadsheetEnvelope(padded)).toThrow(UnsafeSpreadsheetError);
  });

  it('leaves a legacy .xls alone — it is not a ZIP and cannot expand', () => {
    const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);

    expect(assertSafeSpreadsheetEnvelope(ole2)).toBe(0);
  });

  it('rejects a truncated ZIP rather than reading past the buffer', () => {
    const truncated = realisticTimeCard().subarray(0, 40);

    expect(() => assertSafeSpreadsheetEnvelope(truncated)).toThrow(
      UnsafeSpreadsheetError
    );
  });

  it('rejects a file claiming more entries than it contains', () => {
    const zip = buildZip([
      { name: 'a', compressedSize: 1, uncompressedSize: 1 },
    ]);
    zip.writeUInt16LE(50, zip.length - 22 + 10); // lie about the entry count

    expect(() => assertSafeSpreadsheetEnvelope(zip)).toThrow(UnsafeSpreadsheetError);
  });
});

describe('parseAttendanceWorkbook — the guard is actually wired in', () => {
  // Generous timeout: this is the only test that pulls in lib/platform/attendance,
  // which drags in the whole `xlsx` package. A cold import of that costs ~0.3s
  // idle but can take several seconds when the rest of the suite is competing
  // for I/O — a slow import is not a failing guard.
  it('refuses a bomb before handing anything to the XLSX parser', async () => {
    // Guards the integration, not just the helper: the check has to run inside
    // parseAttendanceWorkbook, since that is what the upload route calls.
    const { parseAttendanceWorkbook } = await import('@/lib/platform/attendance');
    const bomb = buildZip([
      {
        name: 'xl/worksheets/sheet1.xml',
        compressedSize: 4_200,
        uncompressedSize: 4_000_000_000,
      },
    ]);

    expect(() => parseAttendanceWorkbook(bomb)).toThrow(/too large/i);
  }, 60_000);
});
