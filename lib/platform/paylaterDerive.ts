/**
 * THE DERIVED FIELDS AND THE FLAGS PANEL — v2's rules, lifted exactly.
 *
 * CLIENT-SAFE (no `server-only`): the customer form recomputes these as you
 * type, and the save route re-checks the blocking ones. One definition, so the
 * screen and the server cannot disagree about whether a file may be saved.
 *
 * Every rule here comes from the prototype rather than from judgement, because
 * each one feeds a document that goes to a court:
 *
 *   • THE NATIONALITY ADJECTIVE IS GENDERED — "سوداني" vs "سودانية". It is
 *     printed in the notice, so the wrong one is a wrong legal document.
 *   • AN ARABIC-SPEAKING NATIONALITY GETS A ONE-PAGE ARABIC NOTICE AND 7
 *     DOCUMENTS; everyone else gets a bilingual two-page notice and 8, the
 *     extra being the translation.
 *   • COMPENSATION IS A TIER, not a percentage: under 10,000 claims 20,000;
 *     10,000 and over claims 50,000.
 *   • THE DELAY IS MEASURED FROM THE NEWEST ORDER, not the oldest, and only
 *     after its paid instalments have run: addMonths(latest order, its paid
 *     count) → the notice date. Measuring from the oldest order overstates the
 *     delay on every file with more than one purchase.
 */

/** Nationalities whose notice is issued in Arabic only. */
export const ARABIC_NATIONALITIES = [
  'Qatar', 'Sudan', 'Egypt', 'Tunisia', 'Morocco', 'Algeria', 'Libya',
  'Saudi Arabia', 'UAE', 'Kuwait', 'Bahrain', 'Oman', 'Jordan', 'Lebanon',
  'Syria', 'Iraq', 'Yemen', 'Palestine', 'Comoros', 'Mauritania', 'Somalia',
  'Djibouti',
];

/** country → [country in Arabic, male adjective, female adjective] */
export const NATIONALITIES: Record<string, [string, string, string]> = {
  Qatar: ['قطر', 'قطري', 'قطرية'],
  Sudan: ['السودان', 'سوداني', 'سودانية'],
  Egypt: ['مصر', 'مصري', 'مصرية'],
  Tunisia: ['تونس', 'تونسي', 'تونسية'],
  Morocco: ['المغرب', 'مغربي', 'مغربية'],
  Algeria: ['الجزائر', 'جزائري', 'جزائرية'],
  Libya: ['ليبيا', 'ليبي', 'ليبية'],
  'Saudi Arabia': ['السعودية', 'سعودي', 'سعودية'],
  UAE: ['الإمارات', 'إماراتي', 'إماراتية'],
  Kuwait: ['الكويت', 'كويتي', 'كويتية'],
  Bahrain: ['البحرين', 'بحريني', 'بحرينية'],
  Oman: ['عمان', 'عماني', 'عمانية'],
  Jordan: ['الأردن', 'أردني', 'أردنية'],
  Lebanon: ['لبنان', 'لبناني', 'لبنانية'],
  Syria: ['سوريا', 'سوري', 'سورية'],
  Iraq: ['العراق', 'عراقي', 'عراقية'],
  Yemen: ['اليمن', 'يمني', 'يمنية'],
  Palestine: ['فلسطين', 'فلسطيني', 'فلسطينية'],
  Mauritania: ['موريتانيا', 'موريتاني', 'موريتانية'],
  Somalia: ['الصومال', 'صومالي', 'صومالية'],
  India: ['الهند', 'هندي', 'هندية'],
  Pakistan: ['باكستان', 'باكستاني', 'باكستانية'],
  Bangladesh: ['بنغلاديش', 'بنغلاديشي', 'بنغلاديشية'],
  'Sri Lanka': ['سريلانكا', 'سريلانكي', 'سريلانكية'],
  Nepal: ['نيبال', 'نيبالي', 'نيبالية'],
  Philippines: ['الفلبين', 'فلبيني', 'فلبينية'],
  Turkey: ['تركيا', 'تركي', 'تركية'],
  Nigeria: ['نيجيريا', 'نيجيري', 'نيجيرية'],
  America: ['أمريكا', 'أمريكي', 'أمريكية'],
  Kenya: ['كينيا', 'كيني', 'كينية'],
  Ghana: ['غانا', 'غاني', 'غانية'],
  // Present in the imported data but not in v2's table. Added rather than left
  // to fall through, so their files get an adjective like everyone else.
  'United Kingdom': ['المملكة المتحدة', 'بريطاني', 'بريطانية'],
  Colombia: ['كولومبيا', 'كولومبي', 'كولومبية'],
};

/** v2's spelling fixes, plus the upper-case forms the import produced. */
const ALIASES: Record<string, string> = {
  america: 'America',
  usa: 'America',
  'united states': 'America',
  srilanka: 'Sri Lanka',
  'sri lanka': 'Sri Lanka',
  ksa: 'Saudi Arabia',
  saudi: 'Saudi Arabia',
  uae: 'UAE',
  uk: 'United Kingdom',
};

/**
 * Resolve a stored nationality to a key of NATIONALITIES.
 *
 * Case-insensitive because the import produced both "Qatar" and "QATAR", and a
 * file whose adjective silently vanished because of a capital letter is exactly
 * the kind of defect that reaches a court unnoticed.
 */
export function normaliseNationality(raw: string | null): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  const hit = Object.keys(NATIONALITIES).find((k) => k.toLowerCase() === lower);
  return hit ?? null;
}

export function isArabicNationality(raw: string | null): boolean {
  const key = normaliseNationality(raw);
  return key !== null && ARABIC_NATIONALITIES.includes(key);
}

/** "سوداني" / "سودانية" — gendered, because the notice prints it. */
export function nationalityAdjective(
  raw: string | null,
  gender: string | null
): string {
  const key = normaliseNationality(raw);
  if (!key) return '';
  const meta = NATIONALITIES[key];
  return gender === 'female' ? meta[2] : meta[1];
}

/** 7 documents for an Arabic notice, 8 when a translation is attached. */
export function documentCount(raw: string | null): number | null {
  if (!normaliseNationality(raw)) return null;
  return isArabicNationality(raw) ? 7 : 8;
}

/** The compensation tier. Not a percentage — two flat figures. */
export function compensation(total: number | null): number | null {
  if (!total) return null;
  return total < 10000 ? 20000 : 50000;
}

/** Arabic renders 1 and 2 as their own words, then 3–10 spelled out. */
const ARABIC_NUMERALS = [
  '', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة',
  'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة',
];

/** The delay as it is written in the memo: "(شهرين)", "(ثلاثة أشهر)". */
export function delayWord(n: number | null): string {
  if (!n || n < 1) return '—';
  if (n === 1) return '(شهر)';
  if (n === 2) return '(شهرين)';
  if (n <= 10) return `(${ARABIC_NUMERALS[n]} أشهر)`;
  return `(${n} أشهر)`;
}

/** Month arithmetic that does not roll 31 Jan into 3 March. */
function addMonths(d: Date, m: number): Date {
  const x = new Date(d.getTime());
  const day = x.getDate();
  x.setMonth(x.getMonth() + m);
  if (x.getDate() < day) x.setDate(0);
  return x;
}

function monthDiff(a: Date, b: Date): number {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

export interface DerivedOrder {
  orderDate: string | null;
  paidCount: number | null;
  amount: number | null;
  paidTotal: number | null;
  remaining: number | null;
  orderRef: string | null;
  storeAr: string | null;
  instalment: number | null;
}

/**
 * The delay in months, and whether two orders tie for the newest date.
 *
 * Measured from the NEWEST order once its paid instalments have run — not from
 * the oldest. A customer whose latest purchase is recent has not been in default
 * since their first one.
 */
export function delayMonths(
  orders: DerivedOrder[],
  noticeDate: string | null
): { months: number | null; tie: boolean } {
  const dated = orders
    .filter((o) => o.orderDate)
    .slice()
    .sort((a, b) => (a.orderDate! < b.orderDate! ? -1 : 1));
  if (dated.length === 0 || !noticeDate) return { months: null, tie: false };

  const last = dated[dated.length - 1];
  const tie =
    dated.length > 1 && dated[dated.length - 2].orderDate === last.orderDate;

  const from = addMonths(new Date(last.orderDate!), last.paidCount ?? 0);
  const months = monthDiff(from, new Date(noticeDate));
  return { months, tie };
}

/** Is the notice date inside the last 10 days of its month? (v2's rule.) */
export function noticeDateInWindow(noticeDate: string | null): boolean {
  if (!noticeDate) return true;
  const d = new Date(noticeDate);
  if (Number.isNaN(d.getTime())) return true;
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return d.getDate() >= lastDay - 9;
}

// ---------------------------------------------------------------------------
// The flags panel
// ---------------------------------------------------------------------------

export type FlagKind = 'err' | 'warn' | 'ok';
export interface Flag {
  kind: FlagKind;
  text: string;
  /** Which control to point at. Errors naming a field block the save. */
  field?: string;
}

/** The fields v2 refuses to save without. */
export const REQUIRED_FIELDS = [
  'nameAr', 'nameEn', 'qid', 'nationality', 'paylaterRegDate',
  'reportDate', 'debtTotal', 'noticePlanned',
] as const;

/** Every one of these must be filled on every order. */
export const REQUIRED_ORDER_FIELDS = [
  'orderRef', 'orderDate', 'storeAr', 'amount',
  'instalment', 'paidCount', 'paidTotal', 'remaining',
] as const;

export interface FlagInput {
  values: Record<string, string>;
  gender: string;
  qidName: string;
  nameEn: string;
  debtTotal: number | null;
  noticePlanned: string;
  orders: DerivedOrder[];
  tie: boolean;
  /** A QID already saved on another file, with the batch that holds it. */
  duplicateInBatch?: string | null;
  /** A file being created, rather than one being edited. See the flag below. */
  isNewFile?: boolean;
  /** Differences the extraction kept rather than overwrote. */
  kept?: string[];
  /** Labels for the required fields, in the current language. */
  label: (field: string) => string;
  t: (key: string, vars?: Record<string, string>) => string;
}

/**
 * Build the flags panel and decide whether the file may be saved.
 *
 * ERRORS BLOCK. That is v2's design and it is right for this data: a notice
 * built from a record missing its QID, or with an order that does not add up,
 * is a defective legal document. Warnings do not block — they are things worth
 * a second look that a person may legitimately overrule.
 */
export function buildFlags(input: FlagInput): {
  flags: Flag[];
  blocking: string[];
} {
  const flags: Flag[] = [];
  const blocking: string[] = [];
  const { t, label } = input;

  const missing = REQUIRED_FIELDS.filter(
    (f) => !String(input.values[f] ?? '').trim()
  );
  if (missing.length) {
    flags.push({
      kind: 'err',
      text: `${t('flReq')} ${missing.map(label).join('، ')}`,
    });
    blocking.push(...missing);
  }

  if (!input.gender) {
    flags.push({ kind: 'err', text: t('flGender'), field: 'gender' });
    blocking.push('gender');
  }

  if (input.orders.length === 0) {
    flags.push({ kind: 'err', text: t('flNoOrders'), field: 'orders' });
    blocking.push('orders');
  }
  input.orders.forEach((o, i) => {
    const incomplete = REQUIRED_ORDER_FIELDS.some((k) => {
      const v = (o as unknown as Record<string, unknown>)[k];
      return v === null || v === undefined || String(v).trim() === '';
    });
    if (incomplete) {
      flags.push({
        kind: 'err',
        text: t('flOrderIncomplete', { n: String(i + 1) }),
        field: 'orders',
      });
      blocking.push('orders');
    }
  });

  const qid = String(input.values.qid ?? '').trim();
  if (qid) {
    if (input.duplicateInBatch) {
      /*
        BLOCKS A NEW FILE, WARNS ON AN EXISTING ONE.

        v2 treats any duplicate QID as an error that stops the save, and for a
        NEW file that is exactly right: creating a second file for someone who
        already has one is the mistake worth refusing.

        Applied to a file that already exists it does something else entirely —
        it freezes the record. Repeat customers are real (three in the batch
        this was built against, and every rehearsal import makes more), and
        under that rule nobody could ever correct a name, confirm a gender or
        fix a mobile number on any of them. The duplicate is still named, in
        the same place, with the same batch code; it just no longer prevents
        someone from repairing data that is already in the system.
      */
      const isNew = input.isNewFile === true;
      flags.push({
        kind: isNew ? 'err' : 'warn',
        text: `${t('flDuplicate')} — ${input.duplicateInBatch}`,
        field: 'qid',
      });
      if (isNew) blocking.push('qid');
    }
    // EXACTLY ELEVEN. v2 blocks on this and so do we, now that the 258
    // trailing-zero QIDs have been corrected: what is left is a genuinely
    // malformed value, and a notice carrying one identifies nobody.
    if (!/^\d{11}$/.test(qid)) {
      flags.push({ kind: 'err', text: t('flQidLen'), field: 'qid' });
      blocking.push('qid');
    }
  }

  // The card name being fuller than the report name usually means the report
  // was abbreviated — worth checking before it goes on a filing.
  const qn = input.qidName.trim();
  const en = input.nameEn.trim();
  if (qn && en && qn.length > en.length) {
    flags.push({ kind: 'warn', text: t('flName') });
  }

  const sum = input.orders.reduce((s, o) => s + (o.remaining ?? 0), 0);
  if (input.orders.length && input.debtTotal && Math.abs(sum - input.debtTotal) > 0.05) {
    flags.push({
      kind: 'warn',
      text: `${t('flSum')}  (${sum.toLocaleString('en-US')} ≠ ${input.debtTotal.toLocaleString('en-US')})`,
    });
  }

  input.orders.forEach((o, i) => {
    if (
      o.amount !== null &&
      o.paidTotal !== null &&
      o.remaining !== null &&
      Math.abs(o.paidTotal + o.remaining - o.amount) > 0.05
    ) {
      flags.push({ kind: 'warn', text: t('flOrderSplit', { n: String(i + 1) }) });
    }
  });

  if (!noticeDateInWindow(input.noticePlanned)) {
    flags.push({ kind: 'warn', text: t('flNoticeWindow') });
  }

  if (input.tie) flags.push({ kind: 'warn', text: t('flTie') });

  for (const k of input.kept ?? []) flags.push({ kind: 'warn', text: k });

  if (flags.length === 0) flags.push({ kind: 'ok', text: t('flOk') });

  const rank = (k: FlagKind) => (k === 'err' ? 0 : k === 'warn' ? 1 : 2);
  flags.sort((a, b) => rank(a.kind) - rank(b.kind));

  return { flags, blocking: [...new Set(blocking)] };
}
