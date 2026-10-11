/**
 * The monthly PayLater Excel — column mapping and preview.
 *
 * Lifted from v2, whose header matching was arrived at against the firm's real
 * files and is not guesswork:
 *
 *   • Header spellings are matched AS THE FILES SPELL THEM, typos included.
 *     `NATOINALITY` is the real column name. `CASE REGISTRATION ` really does
 *     carry a trailing space. Correcting them here would mean failing to read
 *     the actual files.
 *
 *   • Matching is EXACT FIRST, then longest-prefix. v2 records why: a plain
 *     prefix match let the `NO.` alias claim `Notice Date`, and `Shopper Name`
 *     claim `Shopper Name NATIVE`. Trying exact matches for every column before
 *     any prefix match is what stops a short alias from stealing a longer
 *     column.
 *
 *   • Anything not on the list is IGNORED AND REPORTED, never treated as an
 *     error. The files carry columns this portal has no use for (`MOI CHECK`),
 *     and refusing a file for containing one would be refusing every real file.
 *
 * Parsing happens SERVER-SIDE, unlike v2 which did it in the browser. The bytes
 * pass the decompression-bomb guard first, exactly as the attendance sheet does.
 */

import * as XLSX from 'xlsx';
import { assertSafeSpreadsheetEnvelope } from './spreadsheetGuard';

/** The columns the portal reads, each with the spellings seen in real files. */
const COLUMNS: { field: string; aliases: string[] }[] = [
  { field: 'rowNo', aliases: ['NO.', 'NO', '#'] },
  { field: 'nameEn', aliases: ['Shopper Name'] },
  // Must be listed so the exact pass claims it before `Shopper Name` prefixes it.
  { field: 'nameAr', aliases: ['Shopper Name NATIVE'] },
  { field: 'mobile', aliases: ['Phone Number'] },
  { field: 'email', aliases: ['Email'] },
  // The typo is the real column name in the firm's files.
  { field: 'nationality', aliases: ['NATOINALITY', 'NATIONALITY'] },
  { field: 'qid', aliases: ['QID'] },
  { field: 'instalmentCount', aliases: ['INSTALLMENT', 'INSTALMENT'] },
  { field: 'debtTotal', aliases: ['Amount Due (QAR)', 'Amount Due'] },
  { field: 'dpd', aliases: ['DPD'] },
  /*
    The Ministry of Interior residency check. "IN" on every row of the batch
    this was written against, and the value that matters is the other one: a
    notice cannot be served on somebody who has left the country, so a file
    marked otherwise is one the enforcement step has to handle differently.
    It was being read and dropped as an unrecognised column.
  */
  { field: 'moiCheck', aliases: ['MOI CHECK', 'MOI'] },
  { field: 'noticePlanned', aliases: ['Notice Date'] },
  // The trailing space is real.
  { field: 'caseRegDate', aliases: ['CASE REGISTRATION ', 'CASE REGISTRATION'] },
];

export interface ParsedRow {
  rowNo: number | null;
  nameEn: string | null;
  nameAr: string | null;
  mobile: string | null;
  email: string | null;
  nationality: string | null;
  qid: string | null;
  instalmentCount: number | null;
  debtTotal: number | null;
  dpd: number | null;
  moiCheck: string | null;
  /**
   * Every column the portal has no field for, header → value, verbatim.
   * Empty when the sheet holds nothing unfamiliar.
   */
  extra: Record<string, string>;
  noticePlanned: string | null;
  caseRegDate: string | null;
}

export interface ImportPreview {
  totalRows: number;
  rows: ParsedRow[];
  /** Rows carrying no QID — they cannot be matched or deduplicated. */
  noQidCount: number;
  /** Header cells the portal does not read. Reported, not an error. */
  ignoredColumns: string[];
  /** Header cells the portal expected and did not find. */
  missingColumns: string[];
}

const norm = (v: unknown): string => String(v ?? '').trim();

/**
 * Resolve header cells to fields — exact for every column first, then
 * longest-prefix for whatever is still unclaimed.
 */
export function mapHeaders(header: unknown[]): {
  index: Partial<Record<string, number>>;
  ignored: string[];
  missing: string[];
  /** Unmapped columns, with the position their values sit in. */
  extraAt: { header: string; at: number }[];
} {
  const cells = header.map((h) => norm(h));
  const index: Partial<Record<string, number>> = {};
  const claimed = new Set<number>();

  // Pass 1 — exact, case-insensitive, whitespace preserved where it matters.
  for (const col of COLUMNS) {
    for (let i = 0; i < cells.length; i++) {
      if (claimed.has(i)) continue;
      if (col.aliases.some((a) => a.trim().toLowerCase() === cells[i].toLowerCase())) {
        index[col.field] = i;
        claimed.add(i);
        break;
      }
    }
  }

  // Pass 2 — longest-prefix, only for fields still unresolved. Longest first so
  // a longer alias wins the cell a shorter one would also match.
  const remaining = COLUMNS.filter((c) => index[c.field] === undefined).sort(
    (a, b) =>
      Math.max(...b.aliases.map((x) => x.length)) -
      Math.max(...a.aliases.map((x) => x.length))
  );
  for (const col of remaining) {
    let best = -1;
    let bestLen = -1;
    for (let i = 0; i < cells.length; i++) {
      if (claimed.has(i)) continue;
      for (const a of col.aliases) {
        const alias = a.trim().toLowerCase();
        const cell = cells[i].toLowerCase();
        if (cell.startsWith(alias) && alias.length > bestLen) {
          best = i;
          bestLen = alias.length;
        }
      }
    }
    if (best !== -1) {
      index[col.field] = best;
      claimed.add(best);
    }
  }

  const ignored = cells.filter((c, i) => c !== '' && !claimed.has(i));
  /*
    The unmapped columns AND their positions. `ignored` alone said which
    headers the portal did not understand; it could not say what was in them,
    so their values were dropped on the floor. Keeping the index means a column
    the firm adds next month arrives with its data instead of as a name in a
    warning.
  */
  const extraAt: { header: string; at: number }[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== '' && !claimed.has(i)) extraAt.push({ header: cells[i], at: i });
  }
  const missing = COLUMNS.filter((c) => index[c.field] === undefined).map(
    (c) => c.aliases[0]
  );
  return { index, ignored, missing, extraAt };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

/** Excel gives a Date with cellDates:true; anything else is read as text. */
const date = (v: unknown): string | null => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  const s = norm(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/**
 * A QID is read as TEXT, never as a number.
 *
 * This is the whole reason 258 of the imported records carry a spurious
 * trailing zero (see migration #34): somewhere upstream a QID went through a
 * numeric type and came back changed. Reading the cell as text here is what
 * stops this import from adding to that pile.
 */
const qid = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    // Already numeric in the sheet — render without exponent or separators, and
    // it is the sheet's own formatting that has lost any leading zero, not us.
    return String(BigInt(Math.trunc(v)));
  }
  const s = norm(v);
  return s === '' ? null : s;
};

export function parseWorkbook(buffer: Buffer): ImportPreview {
  // Refuse a decompression bomb before a byte is inflated — same guard the
  // attendance sheet passes through.
  assertSafeSpreadsheetEnvelope(buffer);

  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  if (workbook.SheetNames.length === 0) throw new Error('The file has no sheets.');

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: null,
    });
    if (raw.length < 2) continue;

    // The header is not always row 0 — these exports carry titles and spacers
    // above it. Take the first row within a generous window that resolves a QID
    // column AND a name column; one alone is too easy to hit by accident.
    let headerIdx = -1;
    let mapped: ReturnType<typeof mapHeaders> | null = null;
    for (let i = 0; i < Math.min(raw.length, 30); i++) {
      const m = mapHeaders(raw[i] as unknown[]);
      if (m.index.qid !== undefined && m.index.nameEn !== undefined) {
        headerIdx = i;
        mapped = m;
        break;
      }
    }
    if (headerIdx === -1 || !mapped) continue;

    const { index, ignored, missing, extraAt } = mapped;
    const at = (r: unknown[], f: string): unknown => {
      const i = index[f];
      return i === undefined ? null : r[i];
    };

    const rows: ParsedRow[] = [];
    for (let i = headerIdx + 1; i < raw.length; i++) {
      const r = raw[i] as unknown[];
      if (!r || r.every((c) => c === null || norm(c) === '')) continue;

      rows.push({
        rowNo: num(at(r, 'rowNo')),
        nameEn: norm(at(r, 'nameEn')) || null,
        nameAr: norm(at(r, 'nameAr')) || null,
        mobile: norm(at(r, 'mobile')) || null,
        email: norm(at(r, 'email')) || null,
        nationality: norm(at(r, 'nationality')) || null,
        qid: qid(at(r, 'qid')),
        instalmentCount: num(at(r, 'instalmentCount')),
        debtTotal: num(at(r, 'debtTotal')),
        dpd: num(at(r, 'dpd')),
        // Upper-cased: the sheet carries both "IN" and "in".
        moiCheck: norm(at(r, 'moiCheck')).toUpperCase() || null,
        noticePlanned: date(at(r, 'noticePlanned')),
        caseRegDate: date(at(r, 'caseRegDate')),
        // Whatever the portal has no field for, kept under the sheet's own
        // heading. An empty cell is left out rather than stored as "".
        extra: Object.fromEntries(
          extraAt
            .map(({ header, at: i }) => [header, norm(r[i])] as const)
            .filter(([, v]) => v !== '')
        ),
      });
    }

    return {
      totalRows: rows.length,
      rows,
      noQidCount: rows.filter((r) => !r.qid).length,
      ignoredColumns: ignored,
      missingColumns: missing,
    };
  }

  throw new Error(
    'No sheet in this file has a recognisable header row (a QID column and a name column).'
  );
}
