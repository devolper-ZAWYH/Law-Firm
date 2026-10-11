'use client';

/**
 * THE CUSTOMER FILE — laid out as the v2 prototype lays it out.
 *
 * Eight sections in the prototype's order: data source, batch and file,
 * customer details, financial summary, orders, the notice, alerts, and the
 * locked case journey. Every field carries a chip saying where its value came
 * from, and the derived fields are shown alongside the typed ones rather than
 * hidden — because the notice and the memo are built from BOTH, and someone
 * checking a filing needs to see the derivation, not just its inputs.
 *
 * VALIDATION IS BLOCKING, and it is v2's list, not an approximation: a missing
 * required field, an unconfirmed gender, no orders, an order with a hole in it,
 * a duplicate QID, or a QID that is not exactly 11 digits. Each of those makes
 * the resulting notice defective, so the save button is disabled until they are
 * cleared. Warnings sit in the same panel and do not block.
 *
 * The rules themselves live in lib/platform/paylaterDerive.ts so the save route
 * can re-check the blocking ones. A form is a suggestion; the route decides.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { usePaylaterLang } from './PaylaterShell';
import type { Strings } from '@/lib/i18n';
import { missingIntakeParts } from '@/lib/platform/paylaterIntake';
import { suggestGender } from '@/lib/platform/paylaterGender';
import { moneyLabel } from '@/lib/platform/paylaterMoney';
import Toast, { type ToastMessage } from './Toast';
import {
  changedIdentityFields,
  type IdentityField,
} from '@/lib/platform/paylaterIdentity';
import {
  NATIONALITIES,
  buildFlags,
  compensation,
  delayMonths,
  delayWord,
  documentCount,
  isArabicNationality,
  nationalityAdjective,
  normaliseNationality,
  type DerivedOrder,
} from '@/lib/platform/paylaterDerive';
import type { PaylaterCustomerFull, PaylaterOrder } from '@/lib/platform/paylater';

type OrderDraft = Omit<PaylaterOrder, 'id'> & { id: string | null };

const blankOrder = (i: number): OrderDraft => ({
  id: null, orderRef: '', orderDate: '', storeAr: '', storeEn: '',
  amount: null, instalment: null, paidCount: null, paidTotal: null,
  remaining: null, sortIndex: i,
});

const n = (v: string): number | null => {
  const s = v.trim();
  if (s === '') return null;
  const x = Number(s.replace(/,/g, ''));
  return Number.isFinite(x) ? x : null;
};
const s = (v: string | null): string => v ?? '';
const ns = (v: number | null): string => (v === null ? '' : String(v));

/** The known import artifact: 11 real digits followed by a spurious 0. */
export function isTrailingZeroQid(qid: string): boolean {
  return /^\d{11}0$/.test(qid.trim());
}

/** Where a field's current value came from. Drives the chip beside its label. */
type Origin = 'au' | 'mn' | 'ed' | 'cf';


/**
 * Chip, Field and Section are defined HERE, at module level, and deliberately
 * not inside the component.
 *
 * A component declared inside another component is a NEW COMPONENT TYPE on
 * every render, so React unmounts and remounts the whole subtree each time any
 * state changes. On this form that meant the input you were typing into was
 * destroyed and rebuilt after every keystroke: focus was lost, the caret jumped
 * to the end, and a second character could not be typed without clicking back
 * in. The fields also stopped reflecting later edits, because the element being
 * written to had already been detached.
 *
 * The shared bits they need travel by context rather than through twenty-five
 * call sites. The context VALUE changes on every render, which is fine — that
 * re-renders consumers without remounting them.
 */
interface FormCtxValue {
  origins: Record<string, Origin>;
  blocking: string[];
  mark: (field: string, kind: Origin) => void;
  t: Strings;
}
const FormCtx = createContext<FormCtxValue | null>(null);
const useFormCtx = (): FormCtxValue => {
  const v = useContext(FormCtx);
  if (!v) throw new Error('CustomerForm field rendered outside its provider');
  return v;
};

function Chip({ kind }: { kind: Origin }) {
  const { t } = useFormCtx();
  return (
    <span className={`pl-chip ${kind}`}>
      {kind === 'au' ? t.plChipAuto
        : kind === 'mn' ? t.plChipManual
        : kind === 'ed' ? t.plChipEdited
        : t.plChipConfirm}
    </span>
  );
}

function Field({
  id, label, value, onChange, type = 'text', ltr = false, chip = 'mn',
  span2 = false, hint, maxLength, auto = false, disabled = false,
}: {
  id: string; label: string; value: string; onChange?: (v: string) => void;
  type?: string; ltr?: boolean; chip?: Origin | null; span2?: boolean;
  hint?: string; maxLength?: number; auto?: boolean; disabled?: boolean;
}) {
  const { origins, blocking, mark } = useFormCtx();
  return (
    <div className={`pl-f${span2 ? ' span2' : ''}`}>
      <span className="pl-lab">
        <b>{label}</b>
        {chip && <Chip kind={origins[id] ?? chip} />}
      </span>
      <input
        id={`pl-${id}`}
        type={type}
        value={value}
        maxLength={maxLength}
        disabled={disabled || !onChange}
        className={`${auto ? 'pl-auto' : ''}${blocking.includes(id) ? ' pl-miss' : ''}`}
        dir={ltr || type === 'date' ? 'ltr' : undefined}
        onChange={(e) => {
          onChange?.(e.target.value);
          if (chip !== null) mark(id, 'ed');
        }}
      />
      {hint && <span className="pl-hint">{hint}</span>}
    </div>
  );
}

function Section({
  title, pill, locked = false, children,
}: { title: string; pill?: string | number; locked?: boolean; children: ReactNode }) {
  return (
    <section className={`pl-sec${locked ? ' locked' : ''}`}>
      <div className="pl-sechead">
        <span className="pl-sq" aria-hidden="true" />
        <h2>{title}</h2>
        {pill !== undefined && <span className="pl-pill" dir="ltr">{pill}</span>}
      </div>
      <div className="dash-card">{children}</div>
    </section>
  );
}

export default function CustomerForm({
  customer,
  batchId,
  batchCode,
  batches,
  employees,
  canEditFiles,
  canDeleteFiles,
  onSaved,
}: {
  customer: PaylaterCustomerFull | null;
  batchId: string;
  batchCode: string;
  /** Every batch, so a file can be moved between them as v2 allows. */
  batches: { id: string; code: string; month: string }[];
  /** Who the file can be handed to — the same list the Team Leader assigns from. */
  employees: { userId: string; name: string }[];
  canEditFiles: boolean;
  /** May remove this file. An admin holds it even when canEditFiles does not. */
  canDeleteFiles: boolean;
  /**
   * Set when the form is rendered inside the drawer. Its presence is also what
   * tells the form it is NOT a page: a save must not navigate anywhere (the
   * batch is right there behind it) and Cancel closes rather than routes.
   */
  onSaved?: () => void;
}) {
  const { lang, t, dir } = usePaylaterLang();
  const router = useRouter();

  const [batch, setBatch] = useState(batchId);
  const [fileNoManual, setFileNoManual] = useState(s(customer?.fileNoManual ?? null));
  const [handler, setHandler] = useState(s(customer?.handlerName ?? null));

  const [nameAr, setNameAr] = useState(s(customer?.nameAr ?? null));
  const [nameEn, setNameEn] = useState(s(customer?.nameEn ?? null));
  const [qidName, setQidName] = useState(s(customer?.qidName ?? null));
  const [qid, setQid] = useState(s(customer?.qid ?? null));
  const [nationality, setNationality] = useState(
    normaliseNationality(customer?.nationality ?? null) ?? ''
  );
  const [gender, setGender] = useState(s(customer?.gender ?? null));
  const [regDate, setRegDate] = useState(s(customer?.paylaterRegDate ?? null));
  const [mobile, setMobile] = useState(s(customer?.mobile ?? null));
  const [email, setEmail] = useState(s(customer?.email ?? null));

  const [reportDate, setReportDate] = useState(s(customer?.reportDate ?? null));
  const [debtTotal, setDebtTotal] = useState(ns(customer?.debtTotal ?? null));
  /**
   * The unit this file's money is in (#38). Set by the report when one is read;
   * QAR otherwise, which is what every file imported from the monthly
   * spreadsheet is — that sheet names no currency at all.
   */
  const [currency, setCurrency] = useState(customer?.currency ?? 'QAR');
  /** From the monthly sheet's MOI CHECK column (#39). */
  const [moiCheck, setMoiCheck] = useState(customer?.moiCheck ?? '');
  const [instalmentCount, setInstalmentCount] = useState(ns(customer?.instalmentCount ?? null));
  const [dpd, setDpd] = useState(ns(customer?.dpd ?? null));

  const [noticePlanned, setNoticePlanned] = useState(s(customer?.noticePlanned ?? null));
  const [caseRegDate, setCaseRegDate] = useState(s(customer?.caseRegDate ?? null));
  const [delay, setDelay] = useState(ns(customer?.delayMonths ?? null));
  const delayTouched = useRef(false);

  const [orders, setOrders] = useState<OrderDraft[]>(
    customer && customer.orders.length > 0
      ? customer.orders.map((o) => ({ ...o }))
      : [blankOrder(0)]
  );

  const [origins, setOrigins] = useState<Record<string, Origin>>({});
  const mark = useCallback((field: string, kind: Origin) => {
    setOrigins((p) => (p[field] === kind ? p : { ...p, [field]: kind }));
  }, []);

  const [mode, setMode] = useState<'upload' | 'manual'>('upload');
  const [overwrite, setOverwrite] = useState(false);
  const [reading, setReading] = useState(false);
  const [kept, setKept] = useState<string[]>([]);
  const [extractNote, setExtractNote] = useState<string | null>(null);
  /** Picked, not yet read — v2 separates choosing from extracting. */
  const [chosen, setChosen] = useState<File[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armDelete, setArmDelete] = useState(false);
  const [duplicate, setDuplicate] = useState<{ id: string; name: string; batchCode: string } | null>(null);
  /**
   * EVERY OTHER FILE THIS PERSON HOLDS, kept from the same lookup that feeds
   * the duplicate banner. Held here so pressing Save can ask its question
   * immediately instead of putting a network round trip between the click and
   * the dialog.
   */
  const [siblings, setSiblings] = useState<
    { id: string; nameAr: string | null; nameEn: string | null; batchCode: string; rowNo: number | null }[]
  >([]);
  /** The confirmation, while it is open: which fields changed, and to where. */
  const [copyAsk, setCopyAsk] = useState<IdentityField[] | null>(null);
  const [copyPick, setCopyPick] = useState<Set<IdentityField>>(new Set());
  /** The centred, self-dismissing reply. See components/collections/Toast.tsx. */
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const say = (text: string, kind: 'ok' | 'err') =>
    setToast({ text, kind, at: Date.now() });

  // ---- derived ----------------------------------------------------------
  const total = n(debtTotal);
  const derivedOrders: DerivedOrder[] = useMemo(
    () =>
      orders.map((o) => ({
        orderDate: o.orderDate || null,
        paidCount: o.paidCount,
        amount: o.amount,
        paidTotal: o.paidTotal,
        remaining: o.remaining,
        orderRef: o.orderRef || null,
        storeAr: o.storeAr || null,
        instalment: o.instalment,
      })),
    [orders]
  );
  const filledOrders = useMemo(
    () =>
      derivedOrders.filter(
        (o) => o.orderRef || o.orderDate || o.storeAr || o.amount !== null
      ),
    [derivedOrders]
  );

  const { months: autoDelay, tie } = useMemo(
    () => delayMonths(filledOrders, noticePlanned || null),
    [filledOrders, noticePlanned]
  );

  // The prototype fills the delay automatically until somebody edits it, and
  // then leaves their number alone.
  useEffect(() => {
    if (!delayTouched.current && autoDelay !== null && autoDelay >= 0) {
      setDelay(String(autoDelay));
    }
  }, [autoDelay]);

  const natAdj = nationalityAdjective(nationality, gender);
  const docs = documentCount(nationality);
  const comp = compensation(total);
  const noticeType = nationality
    ? isArabicNationality(nationality)
      ? t.plNoticeAr
      : t.plNoticeBi
    : '';
  const salutation = gender === 'female' ? t.plSalutF : gender === 'male' ? t.plSalutM : '—';

  // ---- duplicate QID, checked against the server as v2 checks its store ----
  useEffect(() => {
    const v = qid.trim();
    if (!/^\d{6,}$/.test(v)) {
      setDuplicate(null);
      setSiblings([]);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/paylater/customers/lookup?qid=${encodeURIComponent(v)}${customer ? `&exclude=${customer.id}` : ''}`
        );
        const d = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          found?: { id: string; name: string; batchCode: string } | null;
          others?: {
            id: string; nameAr: string | null; nameEn: string | null;
            batchCode: string; rowNo: number | null;
          }[];
        };
        if (!cancelled) {
          setDuplicate(d.ok ? (d.found ?? null) : null);
          setSiblings(d.ok ? (d.others ?? []) : []);
        }
      } catch {
        /* a failed check must not invent a duplicate */
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [qid, customer]);

  // ---- flags ------------------------------------------------------------
  const labelFor = useCallback(
    (f: string): string =>
      ({
        nameAr: t.plNameAr, nameEn: t.plNameEn, qid: t.plQid,
        nationality: t.plNationality, paylaterRegDate: t.plRegDate,
        reportDate: t.plReportDate, debtTotal: t.plDebtTotal,
        noticePlanned: t.plNoticeDate,
      })[f] ?? f,
    [t]
  );
  const tr = useCallback(
    (key: string, vars?: Record<string, string>) => {
      let out = (t as unknown as Record<string, string>)[key] ?? key;
      for (const [k, v] of Object.entries(vars ?? {})) out = out.replace(`{${k}}`, v);
      return out;
    },
    [t]
  );

  const { flags, blocking } = useMemo(
    () =>
      buildFlags({
        values: {
          nameAr, nameEn, qid, nationality,
          paylaterRegDate: regDate, reportDate, debtTotal, noticePlanned,
        },
        gender, qidName, nameEn,
        debtTotal: total,
        noticePlanned,
        orders: filledOrders,
        tie,
        duplicateInBatch: duplicate?.batchCode ?? null,
        isNewFile: !customer,
        kept,
        label: labelFor,
        t: tr,
      }),
    [nameAr, nameEn, qid, nationality, regDate, reportDate, debtTotal,
     noticePlanned, gender, qidName, total, filledOrders, tie, duplicate,
     kept, labelFor, tr]
  );

  /** Read from the Arabic name as it is typed; never written on its own. */
  const genderHint = useMemo(() => suggestGender(nameAr), [nameAr]);

  const liveMissing = missingIntakeParts({
    gender: gender || null,
    reportDate: reportDate || null,
    paylaterRegDate: regDate || null,
    orderCount: filledOrders.length,
  });

  const blocked = blocking.length > 0;
  const errCount = flags.filter((f) => f.kind !== 'ok').length;

  function setOrder(i: number, patch: Partial<OrderDraft>) {
    setOrders((prev) => prev.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  }

  // ---- reading the report ------------------------------------------------
  async function readReport(files: File[]) {
    const pdf = files.find((f) => f.type === 'application/pdf');
    if (!pdf) {
      setError(lang === 'ar' ? 'اختر ملف PDF.' : 'Choose a PDF file.');
      return;
    }
    setReading(true);
    setError(null);
    setExtractNote(null);
    setKept([]);
    try {
      const body = new FormData();
      body.set('file', pdf);
      const res = await fetch('/api/paylater/extract', { method: 'POST', body });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; extracted?: Record<string, unknown>;
      };
      if (!res.ok || !data.ok || !data.extracted) {
        setError(data.error ?? 'Could not read that report.');
        setReading(false);
        return;
      }
      const x = data.extracted as {
      currency?: string;
        qid: string | null; nameEn: string | null; nationality: string | null;
        email: string | null; mobile: string | null; paylaterRegDate: string | null;
        reportDate: string | null; debtTotal: number | null;
        pendingInstalments: number; orders: OrderDraft[]; warnings: string[];
      };

      let filled = 0;
      const keptList: string[] = [];
      const put = (
        field: string, label: string, current: string,
        next: string | null, set: (v: string) => void
      ) => {
        if (next === null || next === '') return;
        if (current.trim() === '' || overwrite) {
          if (current.trim() !== next) filled++;
          set(next);
          mark(field, 'ed');
        } else if (current.trim() !== next) {
          keptList.push(
            t.plExtractKept.replace('{field}', label).replace('{value}', next)
          );
        }
      };

      put('qid', t.plQid, qid, x.qid, setQid);
      put('nameEn', t.plNameEn, nameEn, x.nameEn, setNameEn);
      put('nationality', t.plNationality, nationality,
        normaliseNationality(x.nationality) ?? null, setNationality);
      put('email', t.plEmail, email, x.email, setEmail);
      put('mobile', t.plMobile, mobile, x.mobile, setMobile);
      put('paylaterRegDate', t.plRegDate, regDate, x.paylaterRegDate, setRegDate);
      put('reportDate', t.plReportDate, reportDate, x.reportDate, setReportDate);
      put('debtTotal', t.plDebtTotal, debtTotal,
        x.debtTotal === null ? null : String(x.debtTotal), setDebtTotal);
      // The report names the unit its total is in. It is taken quietly rather
      // than through `put`: the currency is not a field anyone types, so it has
      // no "kept the existing value" case to report.
      if (typeof x.currency === 'string' && /^[A-Z]{3}$/.test(x.currency)) {
        setCurrency(x.currency);
      }
      put('instalmentCount', t.plInstalments, instalmentCount,
        x.pendingInstalments ? String(x.pendingInstalments) : null, setInstalmentCount);

      if (x.orders?.length) {
        const hasOrders = orders.some((o) => o.orderRef?.trim());
        if (!hasOrders || overwrite) {
          setOrders(x.orders.map((o, i) => ({ ...blankOrder(i), ...o, id: null, sortIndex: i })));
          filled += x.orders.length;
        } else {
          keptList.push(t.plExtractKept
            .replace('{field}', t.plOrders)
            .replace('{value}', String(x.orders.length)));
        }
      }

      setExtractNote(t.plExtractFilled.replace('{n}', String(filled)));
      say(t.plExtractFilled.replace('{n}', String(filled)), 'ok');
      setKept([...keptList, ...(x.warnings ?? [])]);
      setReading(false);
    } catch {
      setError('Network error.');
      setReading(false);
    }
  }

  // ---- save / delete ----------------------------------------------------
  /**
   * What the person's details were when this file was opened, so a change can
   * be recognised. Only these fields are ever offered for copying — the debt
   * is per file and is never touched.
   */
  const identityNow = {
    nameAr, nameEn, qidName, qid, nationality, gender,
    paylaterRegDate: regDate, mobile, email,
  };
  const identityBefore = {
    nameAr: customer?.nameAr ?? '',
    nameEn: customer?.nameEn ?? '',
    qidName: customer?.qidName ?? '',
    qid: customer?.qid ?? '',
    nationality: customer?.nationality ?? '',
    gender: customer?.gender ?? '',
    paylaterRegDate: customer?.paylaterRegDate ?? '',
    mobile: customer?.mobile ?? '',
    email: customer?.email ?? '',
  };

  /**
   * A value as the FORM shows it, not as the database stores it. "female" is
   * what is written; "Female" is what the person chose from the dropdown, and
   * a dialog asking them to confirm a change has to quote them back to
   * themselves.
   */
  const show = (f: IdentityField, v: unknown) => {
    const raw = v === null || v === undefined ? '' : String(v).trim();
    if (!raw) return '—';
    if (f === 'gender') return raw === 'female' ? t.plFemale : t.plMale;
    return raw;
  };

  /** Field name → the label it carries on screen, for the dialog. */
  const identityLabel: Record<IdentityField, string> = {
    nameAr: t.plNameAr, nameEn: t.plNameEn, qidName: t.plQidName, qid: t.plQid,
    nationality: t.plNationality, gender: t.plGender, paylaterRegDate: t.plRegDate,
    mobile: t.plMobile, email: t.plEmail,
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (blocked) return;
    /*
      ASK BEFORE COPYING. An existing file, a person with other files, and at
      least one changed detail — those three together are the only case where
      the question is worth asking. A new customer has nothing to copy to, and
      a change to the debt is per file by definition.
    */
    const changed = customer ? changedIdentityFields(identityBefore, identityNow) : [];
    if (changed.length && siblings.length) {
      setCopyAsk(changed);
      setCopyPick(new Set(changed));
      return;
    }
    void save([]);
  }

  async function save(copyFields: IdentityField[]) {
    setCopyAsk(null);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/paylater/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: customer?.id ?? null,
          batchId: batch,
          nameAr, nameEn, qidName, qid, nationality, gender, mobile, email,
          paylaterRegDate: regDate || null,
          reportDate: reportDate || null,
          debtTotal: total,
          currency,
          instalmentCount: n(instalmentCount),
          dpd: n(dpd),
          delayMonths: n(delay),
          moiCheck: moiCheck.trim() || null,
          handlerName: handler,
          fileNoManual: fileNoManual.trim() || null,
          noticePlanned: noticePlanned || null,
          caseRegDate: caseRegDate || null,
          orders: orders
            .filter((o) => o.orderRef?.trim() || o.orderDate || o.storeAr?.trim() || o.amount !== null)
            .map((o, i) => ({ ...o, sortIndex: i })),
          // The answer to the copy question. The server re-checks both the
          // field list and that every target really is this person's file.
          propagateFields: copyFields,
          propagateTo: copyFields.length ? siblings.map((x) => x.id) : [],
          priorQid: customer?.qid ?? null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; id?: string; propagated?: number;
        duplicate?: { id: string; name: string; batchCode: string };
      };
      if (!res.ok || !data.ok) {
        // A refusal ALWAYS says so. Showing only the duplicate banner meant a
        // rejected save looked identical to a successful one — the button
        // settled, the banner re-rendered, and the edit was gone.
        if (data.duplicate) setDuplicate(data.duplicate);
        setError(data.error ?? 'Could not save.');
        say(data.error ?? 'Could not save.', 'err');
        setBusy(false);
        return;
      }
      // How many other files were touched goes IN the reply — "Saved" alone
      // would leave somebody guessing whether the copy they asked for happened.
      say(
        data.propagated
          ? `${t.plSaved} ${t.plCopiedTo.replace('{n}', String(data.propagated))}`
          : t.plSaved,
        'ok'
      );
      setBusy(false);
      // In the drawer there is nowhere to go — the batch is already on screen
      // behind it, and it is the thing that needs to hear about the change.
      if (onSaved) onSaved();
      else if (!customer && data.id) router.push(`/collections/customer/${data.id}`);
      else router.refresh();
    } catch {
      setError('Network error.');
      setBusy(false);
    }
  }

  async function remove() {
    // TWO STEPS, as in v2: the first click arms it, the second does it.
    if (!armDelete) {
      setArmDelete(true);
      window.setTimeout(() => setArmDelete(false), 4000);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/paylater/customers/${customer!.id}`, { method: 'DELETE' });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        setError(d.error ?? 'Could not delete.');
        say(d.error ?? 'Could not delete.', 'err');
        setBusy(false);
        return;
      }
      window.location.assign(`/collections/batch/${batch}`);
    } catch {
      setError('Network error.');
      say('Network error.', 'err');
      setBusy(false);
    }
  }

  const ctxValue = useMemo<FormCtxValue>(
    () => ({ origins, blocking, mark, t }),
    [origins, blocking, mark, t]
  );

  return (
    <FormCtx.Provider value={ctxValue}>
    <div dir={dir}>
      <div className="dash-page-head">
        <div>
          <a className="dash-back" href={`/collections/batch/${batchId}`}>
            {/* Mirrors under RTL — a literal arrow does not. */}
            <span className="cal-nav-arrow" aria-hidden="true">
              ←
            </span>{' '}
            <span dir="ltr">{batchCode}</span>
          </a>
          <h1 className="dash-title">
            {nameAr || nameEn || (lang === 'ar' ? 'عميل جديد' : 'New customer')}
          </h1>
          <p className="dash-subtitle">
            {liveMissing.length === 0 ? (
              <span className="dash-chip">{t.plIntakeDone}</span>
            ) : (
              <span className="dash-chip dash-chip-danger" title={t.plIntakeExplained}>
                {t.plIntakeMissing}:{' '}
                {liveMissing
                  .map((m) => m === 'gender' ? t.plMissGender
                    : m === 'reportDate' ? t.plMissReportDate
                    : m === 'regDate' ? t.plMissRegDate : t.plMissOrders)
                  .join(lang === 'ar' ? '، ' : ', ')}
              </span>
            )}
          </p>
        </div>
      </div>

      {!canEditFiles && <div className="dash-alert" role="status">{t.plReadOnlyRole}</div>}

      {/*
        A NOTE, NOT AN ERROR. A repeat customer is ordinary — the person is the
        same and the debt is new — so this said the true thing in the wrong
        voice: red, with role="alert", telling the reader to "open that record
        and fill it", which reads as an instruction to go and do that FIRST.
        People followed it. Nothing here blocks anything; the other file is
        offered, not demanded.
      */}
      {duplicate && (
        <div className="dash-alert" role="status">
          {t.plDuplicateFound
            .replace('{name}', duplicate.name)
            .replace('{batch}', duplicate.batchCode)}{' '}
          <a href={`/collections/customer/${duplicate.id}`}>{t.plOpenExisting}</a>
        </div>
      )}

      <form onSubmit={submit}>
        <fieldset
          disabled={!canEditFiles}
          style={{ border: 0, padding: 0, margin: 0, minInlineSize: 0, minWidth: 0 }}
        >
          {/* 1 — data source */}
          <Section title={t.plSecSource}>
            <div className="pl-seg">
              <button type="button" className={mode === 'upload' ? 'on' : ''}
                onClick={() => setMode('upload')}>{t.plModeUpload}</button>
              <button type="button" className={mode === 'manual' ? 'on' : ''}
                onClick={() => setMode('manual')}>{t.plModeManual}</button>
            </div>
            {mode === 'upload' && (
              <div className="pl-drop" style={{ marginTop: 14 }}>
                <div>{t.plDropTitle}</div>
                {/*
                  CHOOSE, THEN EXTRACT — two steps, as in v2.
                  Reading fired on selection, so picking the wrong file started
                  a write into the form before anyone could look at what they
                  had picked. The list below names what is about to be read, and
                  nothing happens until the button is pressed.
                */}
                <div className="field" style={{ marginTop: 10 }}>
                  <label className="pl-fakebtn">
                    <span>{t.plChooseFiles}</span>
                    <input type="file" multiple accept="application/pdf,image/*"
                      disabled={reading}
                      onChange={(e) => setChosen(Array.from(e.target.files ?? []))} />
                  </label>
                  <button
                    type="button"
                    className="pl-btn p"
                    style={{ marginInlineStart: 8 }}
                    disabled={reading || !chosen.some((f) => f.type === 'application/pdf')}
                    onClick={() => readReport(chosen)}
                  >
                    {t.plExtractRun}
                  </button>
                </div>
                <div className="pl-hint" dir="ltr">
                  {chosen.length === 0
                    ? t.plNoFilesChosen
                    : chosen.map((f) => f.name).join(' · ')}
                </div>
                <label className="pl-hint" style={{ display: 'block' }}>
                  <input type="checkbox" checked={overwrite}
                    onChange={(e) => setOverwrite(e.target.checked)} />{' '}
                  {t.plExtractOverwrite}
                </label>
                <div className="pl-hint">{t.plOvrHint}</div>
                {reading && <p className="pl-hint">{t.plReading}</p>}
                {extractNote && <div className="form-success" role="status">{extractNote}</div>}
                <p className="pl-hint">{t.plDropNote}</p>
                <p className="pl-hint">{t.plExtractNoKey}</p>
              </div>
            )}
          </Section>

          {/* 2 — batch and file */}
          <Section title={t.plSecBatch}>
            <div className="pl-grid">
              <div className="pl-f">
                <span className="pl-lab"><b>{t.plBatch}</b></span>
                <select value={batch} onChange={(e) => setBatch(e.target.value)}>
                  {batches.map((b) => (
                    <option key={b.id} value={b.id}>{b.code}</option>
                  ))}
                </select>
              </div>
              <div className="pl-f">
                <span className="pl-lab">
                  <b>{t.plFileNo}</b>
                  <Chip kind={fileNoManual.trim() ? 'mn' : 'au'} />
                </span>
                <div style={{ display: 'flex', gap: 7 }}>
                  <input value={fileNoManual} placeholder="001" dir="ltr"
                    className={fileNoManual.trim() ? '' : 'pl-auto'}
                    onChange={(e) => setFileNoManual(e.target.value)} />
                  <button type="button" className="pl-btn"
                    style={{ whiteSpace: 'nowrap' }}
                    onClick={() => setFileNoManual('')}>{t.plReauto}</button>
                </div>
                <span className="pl-hint">{t.plFnoHint}</span>
              </div>
              <div className="pl-f">
                <span className="pl-lab"><b>{t.plEmployee}</b></span>
                <select value={handler} onChange={(e) => setHandler(e.target.value)}>
                  <option value="">—</option>
                  {/* The historical name from the spreadsheet is kept as an
                      option even when that person has no portal account. */}
                  {handler && !employees.some((e) => e.name === handler) && (
                    <option value={handler}>{handler}</option>
                  )}
                  {employees.map((e) => (
                    <option key={e.userId} value={e.name}>{e.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </Section>

          {/* 3 — customer details */}
          <Section title={t.plSecCustomer}>
            <div className="pl-grid">
              <Field id="nameAr" label={t.plNameAr} value={nameAr} onChange={setNameAr} span2 />
              <Field id="qid" label={t.plQid} value={qid} onChange={setQid} ltr maxLength={11}
                hint={isTrailingZeroQid(qid)
                  ? (lang === 'ar'
                      ? 'صفر زائد من ملف الإكسل المصدر — الرقم الفعلي هو أول 11 خانة.'
                      : 'Carries a trailing zero from the source spreadsheet — the real QID is the first 11 digits.')
                  : undefined} />
              <Field id="nameEn" label={t.plNameEn} value={nameEn} onChange={setNameEn} ltr span2 />
              <Field id="qidName" label={t.plQidName} value={qidName} onChange={setQidName} ltr />
              <div className="pl-f">
                <span className="pl-lab"><b>{t.plNationality}</b><Chip kind={origins.nationality ?? 'mn'} /></span>
                <select value={nationality}
                  className={blocking.includes('nationality') ? 'pl-miss' : ''}
                  onChange={(e) => { setNationality(e.target.value); mark('nationality', 'ed'); }}>
                  <option value=""></option>
                  {Object.keys(NATIONALITIES).sort().map((k) => (
                    <option key={k} value={k}>{NATIONALITIES[k][0]} — {k}</option>
                  ))}
                </select>
              </div>
              <Field id="natAdj" label={t.plNatAdj} value={natAdj} chip="au" auto />
              <div className="pl-f">
                <span className="pl-lab"><b>{t.plGender}</b><Chip kind={gender ? 'ed' : 'cf'} /></span>
                <select value={gender}
                  className={blocking.includes('gender') ? 'pl-miss' : ''}
                  onChange={(e) => setGender(e.target.value)}>
                  <option value=""></option>
                  <option value="male">{t.plMale}</option>
                  <option value="female">{t.plFemale}</option>
                </select>
                {/*
                  A SUGGESTION, NOT AN ANSWER. Gender is in neither the report
                  nor the QID (see lib/platform/paylaterGender.ts — it was
                  tested, the number carries no signal), so the only thing left
                  to read is the name. Offering it as one click removes the
                  typing without asserting a fact: nothing is written until
                  somebody accepts it, which is what v2's "confirm" chip asked
                  for in the first place.
                */}
                {!gender && genderHint && (
                  <button
                    type="button"
                    className="pl-lnk q"
                    style={{ alignSelf: 'flex-start', marginTop: 4 }}
                    onClick={() => setGender(genderHint)}
                  >
                    {t.plGenderSuggest.replace(
                      '{g}',
                      genderHint === 'female' ? t.plFemale : t.plMale
                    )}
                  </button>
                )}
              </div>
              <Field id="paylaterRegDate" label={t.plRegDate} value={regDate} onChange={setRegDate} type="date" />
              <Field id="mobile" label={t.plMobile} value={mobile} onChange={setMobile} ltr />
              <Field id="email" label={t.plEmail} value={email} onChange={setEmail} ltr />
            </div>
          </Section>

          {/* 4 — financial summary */}
          <Section title={t.plSecFinance}>
            <div className="pl-grid">
              <Field id="reportDate" label={t.plReportDate} value={reportDate} onChange={setReportDate} type="date" />
              {/* The unit goes in the LABEL, not in the box: typing into a
                  field that already reads "QAR" would either be parsed as text
                  or silently stripped. */}
              <Field id="debtTotal" label={moneyLabel(t.plDebtTotal, lang, currency)}
                value={debtTotal} onChange={setDebtTotal} ltr />
              <Field id="instalmentCount" label={t.plInstalments} value={instalmentCount} onChange={setInstalmentCount} ltr />
              <Field id="dpd" label={t.plDpd} value={dpd} onChange={setDpd} ltr />
              {/* Read from the sheet, editable like the rest of it. "IN" means
                  the customer is in the country; the value that matters is the
                  other one, because a notice cannot be served on somebody who
                  has left. */}
              <Field id="moiCheck" label={t.plMoiCheck} value={moiCheck} onChange={setMoiCheck} ltr />
              <Field id="comp" label={moneyLabel(t.plCompensation, lang, currency)}
                value={comp === null ? '' : comp.toLocaleString('en-US')} chip="au" auto ltr />
              <Field id="ordc" label={t.plOrderCount} value={String(filledOrders.length)} chip="au" auto ltr disabled />
            </div>
          </Section>

          {/* 5 — orders */}
          <Section title={t.plSecOrders} pill={filledOrders.length}>
            {/*
              ONE CARD PER ORDER, NOT A TABLE ROW — v2's shape, and the reason
              this section does not scroll sideways. Nine fields across a row
              cannot fit any screen the firm uses, so the table needed a
              horizontal scroller; the person filling a purchase in then had to
              drag the table to reach "remaining", losing sight of which order
              they were in. As a card the same nine fields wrap onto three
              columns, every one keeps its label, and the whole order is
              visible at once.
            */}
            {orders.map((o, i) => (
              <div className="pl-order" key={i}>
                <div className="pl-ohead">
                  <span className="n">
                    {t.plOrder} <b dir="ltr">{i + 1}</b>
                  </span>
                  {/* v2's .lnk — a bare red word, not a bordered button. */}
                  <button
                    type="button"
                    className="pl-lnk"
                    onClick={() => setOrders((p) => p.filter((_, j) => j !== i))}
                  >
                    {t.plRemoveOrder}
                  </button>
                </div>
                <div className="pl-grid">
                  <Field id={`o${i}ref`} label={t.plOrderRef} value={s(o.orderRef)}
                    onChange={(v) => setOrder(i, { orderRef: v })} ltr />
                  <Field id={`o${i}date`} label={t.plOrderDate} value={s(o.orderDate)}
                    onChange={(v) => setOrder(i, { orderDate: v })} type="date" />
                  <Field id={`o${i}sar`} label={t.plStoreAr} value={s(o.storeAr)}
                    onChange={(v) => setOrder(i, { storeAr: v })} />
                  <Field id={`o${i}sen`} label={t.plStoreEn} value={s(o.storeEn)}
                    onChange={(v) => setOrder(i, { storeEn: v })} ltr />
                  <Field id={`o${i}amt`} label={moneyLabel(t.plAmount, lang, currency)} value={ns(o.amount)}
                    onChange={(v) => setOrder(i, { amount: n(v) })} ltr />
                  <Field id={`o${i}inst`} label={t.plInstalment} value={ns(o.instalment)}
                    onChange={(v) => setOrder(i, { instalment: n(v) })} ltr />
                  <Field id={`o${i}pc`} label={t.plPaidCount} value={ns(o.paidCount)}
                    onChange={(v) => setOrder(i, { paidCount: n(v) })} ltr />
                  <Field id={`o${i}pt`} label={moneyLabel(t.plPaidTotal, lang, currency)} value={ns(o.paidTotal)}
                    onChange={(v) => setOrder(i, { paidTotal: n(v) })} ltr />
                  <Field id={`o${i}rem`} label={moneyLabel(t.plRemaining, lang, currency)} value={ns(o.remaining)}
                    onChange={(v) => setOrder(i, { remaining: n(v) })} ltr />
                </div>
              </div>
            ))}
            {/* v2's .addbtn: full width and dashed, so it reads as the empty
                slot at the end of the list rather than a third action. */}
            <button type="button" className="pl-addbtn" style={{ marginTop: 10 }}
              onClick={() => setOrders((p) => [...p, blankOrder(p.length)])}>
              + {t.plAddOrder}
            </button>
          </Section>

          {/*
            EVERYTHING THE SHEET CARRIED THAT THE PORTAL DOES NOT KNOW.

            Shown only when there is something, under the headings the workbook
            itself used, because a heading somebody typed into a spreadsheet is
            the only name this value has. Read-only: the portal has no meaning
            for these, so it cannot validate them and should not pretend to —
            they are here so a column added to next month's sheet arrives with
            its data instead of being dropped, and so somebody can see it and
            decide whether it deserves a real field.
          */}
          {Object.keys(customer?.sheetExtra ?? {}).length > 0 && (
            <Section title={t.plSecFromSheet}>
              <div className="pl-grid">
                {Object.entries(customer!.sheetExtra).map(([k, v]) => (
                  <Field key={k} id={`x-${k}`} label={k} value={v} chip="au" auto disabled />
                ))}
              </div>
            </Section>
          )}

          {/* 6 — the notice */}
          <Section title={t.plSecNotice}>
            <div className="pl-grid">
              <Field id="noticePlanned" label={t.plNoticeDate} value={noticePlanned} onChange={setNoticePlanned} type="date" />
              <Field id="caseRegDate" label={t.plCaseRegDate} value={caseRegDate} onChange={setCaseRegDate} type="date" />
              <div className="pl-f">
                <span className="pl-lab"><b>{t.plDelayMonths}</b><Chip kind={delayTouched.current ? 'ed' : 'au'} /></span>
                <input id="pl-delay" type="number" dir="ltr" value={delay}
                  className={delayTouched.current ? '' : 'pl-auto'}
                  onChange={(e) => { delayTouched.current = true; setDelay(e.target.value); }} />
              </div>
              <Field id="delayw" label={t.plDelayWord} value={delayWord(n(delay))} chip="au" auto disabled />
              <Field id="ntype" label={t.plNoticeType} value={noticeType} chip="au" auto disabled />
              <Field id="docs" label={t.plDocCount} value={docs === null ? '' : String(docs)} chip="au" auto ltr disabled />
              <Field id="salut" label={t.plSalutation} value={salutation} chip="au" auto disabled />
            </div>
          </Section>

          {/* 7 — alerts */}
          <Section title={t.plSecFlags} pill={errCount}>
            <div>
              {flags.map((f, i) => (
                <div key={i} className={`pl-flag ${f.kind}`}>
                  <span className="b" aria-hidden="true" />
                  <span>{f.text}</span>
                </div>
              ))}
            </div>
          </Section>

          {/* 8 — the case journey, not built yet and shown as such */}
          <Section title={t.plSecJourney} pill={t.plLockedPill} locked>
            <span className="pl-hint">{t.plLockedNote}</span>
          </Section>

          {/*
            THE ANSWER SITS WITH THE QUESTION.

            "Saved" and the failure message used to render at the top of the
            page. The Save button is at the BOTTOM of a form eight sections
            long, so pressing it moved nothing anybody could see: the reply was
            a screen away, above the fold, and a save that had actually failed
            looked the same as one that worked. They belong next to the button
            that was pressed.
          */}
          {(canEditFiles || canDeleteFiles) && (
            <div className="dash-actions" style={{ flexWrap: 'wrap' }}>
              {canEditFiles && (
                <>
                  <button className="pl-btn p" type="submit" disabled={busy || blocked}
                    title={blocked ? t.plCantSave : undefined}>
                    {busy ? t.plSaving : t.plSave}
                  </button>
                  <button type="button" className="pl-btn"
                    onClick={() =>
                      onSaved ? onSaved() : router.push(`/collections/batch/${batchId}`)
                    }>
                    {t.plCancel}
                  </button>
                </>
              )}
              {customer && canDeleteFiles && (
                <button type="button" className="pl-btn"
                  style={{ color: 'var(--danger)' }} disabled={busy} onClick={remove}>
                  {armDelete ? t.plConfirmDelete : t.plDelete}
                </button>
              )}
              {error && (
                <div className="form-error" role="alert" style={{ margin: 0, flexBasis: '100%' }}>
                  {error}
                </div>
              )}
            </div>
          )}
          {blocked && <p className="pl-hint" style={{ color: 'var(--danger)' }}>{t.plCantSave}</p>}
        </fieldset>
      </form>

      {/*
        THE COPY QUESTION. Raised only when an existing file's customer details
        changed and the person holds other files — and it names them, so the
        answer is given about known files rather than about "duplicates".
        Every field is ticked to begin with, because a correction is usually
        meant for the person and not for one row of them, but each can be
        dropped: a mobile number that changed for one file only is a real case.
      */}
      {copyAsk && (
        <div
          className="dash-modal-scrim"
          role="dialog"
          aria-modal="true"
          dir={dir}
          onClick={(e) => { if (e.target === e.currentTarget) setCopyAsk(null); }}
        >
          <div className="dash-modal">
            <div className="dash-modal-head">
              <h2 className="dash-title-sm">{t.plCopyTitle}</h2>
              <button type="button" className="dash-modal-close"
                onClick={() => setCopyAsk(null)} aria-label={t.plCancel}>×</button>
            </div>

            <p className="pl-hint">
              {t.plCopyIntro
                .replace('{name}', nameAr || nameEn || qid)
                .replace('{batches}', siblings.map((x) => x.batchCode).join(lang === 'ar' ? '، ' : ', '))}
            </p>

            <div style={{ margin: '12px 0' }}>
              {copyAsk.map((f) => (
                <label key={f} className="pl-hint"
                  style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 6 }}>
                  <input
                    type="checkbox"
                    checked={copyPick.has(f)}
                    onChange={(e) => {
                      setCopyPick((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(f); else next.delete(f);
                        return next;
                      });
                    }}
                  />
                  <span>
                    <b>{identityLabel[f]}</b>{' — '}
                    <span style={{ textDecoration: 'line-through' }} dir="auto">
                      {show(f, identityBefore[f])}
                    </span>
                    {' → '}
                    <span dir="auto">{show(f, identityNow[f])}</span>
                  </span>
                </label>
              ))}
            </div>

            <p className="pl-hint">{t.plCopyDebtNote}</p>

            <div className="dash-modal-actions">
              <button type="button" className="pl-btn" disabled={busy}
                onClick={() => void save([])}>
                {t.plCopyOnly}
              </button>
              <button type="button" className="pl-btn p"
                disabled={busy || copyPick.size === 0}
                onClick={() => void save([...copyPick])}>
                {t.plCopyApply.replace('{n}', String(siblings.length))}
              </button>
            </div>
          </div>
        </div>
      )}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
    </FormCtx.Provider>
  );
}
