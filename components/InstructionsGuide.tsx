'use client';

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useDash } from './DashboardShell';
import { FILE_STATUS_PALETTE } from '@/lib/platform/fileColors';

/**
 * Instructions — Phase 8. A static, role-aware bilingual guide (no DB writes; it
 * only reads the active company's settings to show the current color pace).
 *
 * • Admins + managers → two tabs (Manager guide / Employee guide), default
 *   Manager guide.
 * • Employees → the Employee guide only (no tabs).
 *
 * Bilingual + RTL via useDash().lang (inline strings — no new i18n keys). Kept
 * calm and readable (Coffee & Cardamom): section headers + short paragraphs.
 */

type Tab = 'manager' | 'employee';

export default function InstructionsGuide() {
  const { lang, activeCompany } = useDash();
  const ar = lang === 'ar';
  const companyId = activeCompany?.id ?? '';
  const role = activeCompany?.role ?? 'employee';
  const showBothTabs = role === 'admin' || role === 'manager';

  const [tab, setTab] = useState<Tab>('manager');
  const [daysPerStep, setDaysPerStep] = useState<number | null>(null);

  // Employees only ever see the Employee guide.
  useEffect(() => {
    if (!showBothTabs) setTab('employee');
  }, [showBothTabs]);

  const loadPace = useCallback(async () => {
    if (!companyId) return;
    try {
      const res = await fetch(`/api/companies/${companyId}/settings`, { cache: 'no-store' });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        settings?: { days_per_color_step?: number };
      };
      if (res.ok && data.ok && typeof data.settings?.days_per_color_step === 'number') {
        setDaysPerStep(data.settings.days_per_color_step);
      }
    } catch {
      /* non-fatal — the guide falls back to a generic sentence */
    }
  }, [companyId]);

  useEffect(() => {
    loadPace();
  }, [loadPace]);

  const companyName = activeCompany
    ? ar
      ? activeCompany.nameAr
      : activeCompany.nameEn
    : '';

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 className="dash-title">{ar ? 'التعليمات' : 'Instructions'}</h1>
      <p className="dash-subtitle" style={{ marginBlockEnd: 20 }}>
        {ar
          ? 'دليل موجز لاستخدام المنصّة — بخطوات مرتّبة.'
          : 'A short, step-by-step guide to using the platform.'}
        {companyName ? ` · ${companyName}` : ''}
      </p>

      {showBothTabs && (
        <div role="tablist" aria-label={ar ? 'الأدلة' : 'Guides'} style={tabsWrap}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'manager'}
            style={tabStyle(tab === 'manager')}
            onClick={() => setTab('manager')}
          >
            {ar ? 'دليل المدير' : 'Manager guide'}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'employee'}
            style={tabStyle(tab === 'employee')}
            onClick={() => setTab('employee')}
          >
            {ar ? 'دليل الموظف' : 'Employee guide'}
          </button>
        </div>
      )}

      {tab === 'manager' && showBothTabs ? (
        <ManagerGuide ar={ar} daysPerStep={daysPerStep} companyName={companyName} />
      ) : (
        <EmployeeGuide ar={ar} daysPerStep={daysPerStep} companyName={companyName} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- shared bits */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={sectionCard}>
      <h2 style={sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p style={paragraph}>{children}</p>;
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol style={stepsList}>
      {items.map((it, i) => (
        <li key={i} style={stepItem}>
          {it}
        </li>
      ))}
    </ol>
  );
}

/** The shared color-system legend. */
function ColorLegend({ ar, daysPerStep }: { ar: boolean; daysPerStep: number | null }) {
  const rows: { hex: string; label: string; meaning: string }[] = [
    {
      hex: FILE_STATUS_PALETTE.lgray,
      label: ar ? 'رمادي فاتح' : 'Light gray',
      meaning: ar
        ? 'ملف محتمل جديد — لا تأخير بعد.'
        : 'A fresh potential file — nothing overdue yet.',
    },
    {
      hex: FILE_STATUS_PALETTE.dgray,
      label: ar ? 'رمادي داكن' : 'Dark gray',
      meaning: ar
        ? 'ملف محتمل بدأ يتأخّر خطوة واحدة.'
        : 'A potential file that has slipped one step.',
    },
    {
      hex: FILE_STATUS_PALETTE.yellow,
      label: ar ? 'أصفر' : 'Yellow',
      meaning: ar
        ? 'ملف نشِط جديد أو بداية التأخّر — انتبه.'
        : 'A new active file, or the start of overdue — keep an eye on it.',
    },
    {
      hex: FILE_STATUS_PALETTE.orange,
      label: ar ? 'برتقالي' : 'Orange',
      meaning: ar
        ? 'تأخّر متوسّط — يحتاج متابعة قريبة.'
        : 'Moderately overdue — needs attention soon.',
    },
    {
      hex: FILE_STATUS_PALETTE.red,
      label: ar ? 'أحمر' : 'Red',
      meaning: ar
        ? 'تأخّر حرِج — الأولوية القصوى.'
        : 'Critically overdue — top priority.',
    },
    {
      hex: FILE_STATUS_PALETTE.green,
      label: ar ? 'أخضر' : 'Green',
      meaning: ar
        ? 'ملف مُغلق / منتهٍ — لا إجراء مطلوب.'
        : 'A closed / resolved file — no action needed.',
    },
  ];
  return (
    <div>
      <P>
        {ar
          ? 'يتغيّر لون كل ملف تلقائياً حسب مدى تأخّر مهامه، فتعرف أولوياتك بنظرة واحدة. يتدرّج اللون من الفاتح إلى الأحمر كلما طال التأخّر، والأخضر يعني ملفاً مُغلقاً.'
          : 'Each file’s color changes automatically with how overdue its tasks are, so you can read your priorities at a glance. It climbs from light toward red as time slips, and green means a closed file.'}
      </P>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBlock: 12 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={swatch(r.hex)} aria-hidden="true" />
            <span style={{ fontWeight: 700, minWidth: 96, fontSize: 13.5 }}>{r.label}</span>
            <span style={{ color: 'var(--text-muted, #93908A)', fontSize: 13.5 }}>{r.meaning}</span>
          </div>
        ))}
      </div>
      <P>
        {daysPerStep && daysPerStep > 0
          ? ar
            ? `في هذه الشركة يتقدّم اللون خطوة واحدة كل ${daysPerStep} من أيام العمل من التأخّر (عطلات نهاية الأسبوع لا تُحتسب).`
            : `In this company the color advances one step for every ${daysPerStep} working day${daysPerStep === 1 ? '' : 's'} overdue (weekends don’t count).`
          : ar
          ? 'يحدّد المشرف سرعة تغيّر الألوان من صفحة الإعدادات (عدد أيام العمل لكل خطوة لون).'
          : 'Your admin sets the pace in Settings (working days per color step).'}
      </P>
    </div>
  );
}

/* ------------------------------------------------------------- manager guide */

function ManagerGuide({
  ar,
  daysPerStep,
  companyName,
}: {
  ar: boolean;
  daysPerStep: number | null;
  companyName: string;
}) {
  return (
    <>
      <Section title={ar ? '1. ما هي المنصّة' : '1. What this platform is'}>
        <P>
          {ar
            ? 'منصّة موحّدة لإدارة ملفات العمل ومهامّه عبر عدّة شركات. هدفها أن يبقى كل ملف واضحاً: من يعمل عليه، وما المتبقّي، وما الذي تأخّر — دون جداول متفرّقة أو رسائل ضائعة.'
            : 'A single place to manage your work files and their tasks across several companies. The goal is to keep every file clear: who is working on it, what is left, and what has fallen behind — without scattered sheets or lost messages.'}
        </P>
      </Section>

      <Section title={ar ? '2. الشركات ومبدّل الشركة' : '2. Companies & the company switcher'}>
        <P>
          {ar
            ? 'كل شيء في المنصّة يخصّ شركة واحدة في كل مرّة. إن كنت تدير أكثر من شركة، استخدم «مبدّل الشركة» أعلى القائمة الجانبية للتنقّل بينها؛ تتحدّث كل الشاشات (الملفات، المهام، جهات الاتصال، الإعدادات) لتعرض الشركة المختارة فقط.'
            : 'Everything in the platform belongs to one company at a time. If you manage more than one, use the company switcher at the top of the sidebar to move between them; every screen (Files, Tasks, Contacts, Settings) updates to show only the selected company.'}
        </P>
        {companyName && (
          <P>
            {ar ? `الشركة النشطة الآن: ${companyName}.` : `Your active company right now: ${companyName}.`}
          </P>
        )}
      </Section>

      <Section title={ar ? '3. نظام الألوان' : '3. The color system'}>
        <ColorLegend ar={ar} daysPerStep={daysPerStep} />
      </Section>

      <Section title={ar ? '4. الملفات وطلبات الوصول' : '4. Files & access requests'}>
        <P>
          {ar
            ? 'تُنظَّم الملفات في ثلاثة أقسام: محتمل، نشِط، ومنتهٍ. المشرف هو من ينشئ الملفات؛ أما أنت كمدير فتتابعها وتوزّع مهامها.'
            : 'Files are organised into three sections: Potential, Active, and Expired. The admin creates files; you, as a manager, follow them and assign their tasks.'}
        </P>
        <P>
          {ar
            ? 'لا يرى الموظف ملفاً حتى يُمنح وصولاً إليه. عندما يطلب موظف الوصول إلى ملف، يظهر الطلب في «طلبات الوصول» لدى المشرف للموافقة أو الرفض — وهذه بوابة تحمي خصوصية كل ملف.'
            : 'An employee cannot see a file until they are granted access. When an employee requests access to a file, the request appears under Access Requests for the admin to approve or reject — a gate that protects each file’s privacy.'}
        </P>
      </Section>

      <Section title={ar ? '5. إسناد المهام' : '5. Assigning tasks'}>
        <Steps
          items={[
            ar
              ? 'افتح الملف من شاشة «الملفات» ثم أضِف مهمة جديدة.'
              : 'Open the file from the Files screen and add a new task.',
            ar
              ? 'اكتب وصف المهمة، واختر الموظف المسؤول عن تنفيذها.'
              : 'Write the task description and choose the employee who will do it.',
            ar
              ? 'حدِّد «المعتمِد» — الشخص الذي سيراجع المهمة عند إنجازها ويوافق عليها أو يعيدها.'
              : 'Name the approver — the person who will review the task once it’s done and either approve it or send it back.',
            ar
              ? 'يبدأ عدّاد وقت العمل للمهمة فور إسنادها، وهو ما يحرّك لون الملف.'
              : 'The task’s working-time timer starts as soon as it’s assigned — this is what drives the file’s color.',
          ]}
        />
      </Section>

      <Section title={ar ? '6. المراجعة: الموافقة أو الإعادة' : '6. Reviewing: approve or return'}>
        <P>
          {ar
            ? 'عندما يضع الموظف علامة «تم» على مهمة، تنتقل إلى «بانتظار الموافقة» ويتوقّف عدّادها. تظهر لك عندئذٍ لمراجعتها:'
            : 'When an employee marks a task Done, it moves to Awaiting approval and its timer pauses. It then appears for you to review:'}
        </P>
        <Steps
          items={[
            ar
              ? 'إن كان العمل مكتملاً، اعتمِد المهمة فتُغلق.'
              : 'If the work is complete, approve the task and it closes.',
            ar
              ? 'إن احتاجت تعديلاً، أعِدها مع ملاحظة توضّح المطلوب؛ يعود العدّاد للعمل ويُخطَر الموظف.'
              : 'If it needs changes, send it back with a note explaining what’s needed; the timer resumes and the employee is notified.',
          ]}
        />
      </Section>

      <Section title={ar ? '7. التنبيهات' : '7. Alerts'}>
        <P>
          {ar
            ? 'إن كانت التنبيهات مُفعّلة لهذه الشركة، تصلك إشعارات داخل التطبيق عند تأخّر المهام (برتقالي/أحمر) وعند وضع علامة إنجاز أو إعادة مهمة. راجِع جرس الإشعارات في أسفل القائمة الجانبية.'
            : 'If alerts are enabled for this company, you’ll get in-app notifications for overdue tasks (orange/red) and for task-done and send-back events. Check the notifications bell at the bottom of the sidebar.'}
        </P>
      </Section>

      <Section title={ar ? '8. نصائح' : '8. Tips'}>
        <Steps
          items={[
            ar
              ? 'راجِع الملفات البرتقالية والحمراء أولاً — فهي الأكثر تأخّراً.'
              : 'Scan the orange and red files first — they are the most overdue.',
            ar
              ? 'اكتب أوصاف مهام قصيرة وواضحة حتى يعرف الموظف المطلوب بالضبط.'
              : 'Keep task descriptions short and specific so the employee knows exactly what to do.',
            ar
              ? 'عند الإعادة، اذكر السبب بوضوح في الملاحظة لتوفّر جولة مراجعة إضافية.'
              : 'When sending a task back, state the reason clearly in the note to save an extra review round.',
          ]}
        />
      </Section>
    </>
  );
}

/* ------------------------------------------------------------ employee guide */

function EmployeeGuide({
  ar,
  daysPerStep,
  companyName,
}: {
  ar: boolean;
  daysPerStep: number | null;
  companyName: string;
}) {
  return (
    <>
      <Section title={ar ? '1. ما هي المنصّة' : '1. What this platform is'}>
        <P>
          {ar
            ? 'مكان واحد يجمع ملفاتك ومهامّك. الهدف أن تعرف بوضوح ما المطلوب منك وما أولوياته، دون البحث في رسائل متفرّقة.'
            : 'One place that gathers your files and tasks. The goal is to know clearly what’s asked of you and in what order — without digging through scattered messages.'}
        </P>
        {companyName && (
          <P>{ar ? `شركتك: ${companyName}.` : `Your company: ${companyName}.`}</P>
        )}
      </Section>

      <Section title={ar ? '2. ملفاتك ونظام الألوان' : '2. Your files & the color system'}>
        <P>
          {ar
            ? 'تعرض شاشة «ملفاتي» الملفات التي مُنِحت وصولاً إليها. لون كل ملف يخبرك بمدى إلحاحه:'
            : 'Your “My files” screen shows the files you’ve been granted access to. Each file’s color tells you how urgent it is:'}
        </P>
        <ColorLegend ar={ar} daysPerStep={daysPerStep} />
      </Section>

      <Section title={ar ? '3. طلب الوصول إلى ملف' : '3. Requesting access to a file'}>
        <P>
          {ar
            ? 'إن احتجت ملفاً لا تراه، اطلب الوصول إليه؛ يصل طلبك إلى المشرف للموافقة. بمجرّد الموافقة يظهر الملف في «ملفاتي».'
            : 'If you need a file you can’t see, request access to it; your request goes to the admin to approve. Once approved, the file appears in “My files”.'}
        </P>
      </Section>

      <Section title={ar ? '4. تنفيذ المهام ووضع علامة «تم»' : '4. Doing tasks & marking Done'}>
        <Steps
          items={[
            ar
              ? 'افتح «مهامي» لرؤية المهام المُسنَدة إليك.'
              : 'Open “My tasks” to see the tasks assigned to you.',
            ar
              ? 'ابدأ العمل على المهمة — يعمل عدّاد وقت العمل في الخلفية.'
              : 'Start working on a task — a working-time timer runs in the background.',
            ar
              ? 'عند الانتهاء، ضَع علامة «تم» لترسلها إلى المعتمِد للمراجعة.'
              : 'When you finish, mark it Done to send it to the approver for review.',
          ]}
        />
      </Section>

      <Section title={ar ? '5. الموافقة أو الإعادة' : '5. Approval or return'}>
        <P>
          {ar
            ? 'يراجع المعتمِد مهمتك: إن كانت مكتملة اعتمَدها وأُغلقت؛ وإن احتاجت تعديلاً أعادها إليك مع ملاحظة توضّح المطلوب. عندها تظهر المهمة من جديد في «مهامي» ليعود العمل عليها.'
            : 'The approver reviews your task: if it’s complete they approve it and it closes; if it needs changes they send it back with a note explaining what’s needed. The task then reappears in “My tasks” to work on again.'}
        </P>
      </Section>

      <Section title={ar ? '6. نصائح' : '6. Tips'}>
        <Steps
          items={[
            ar
              ? 'ابدأ بالمهام في الملفات البرتقالية والحمراء — فهي الأكثر تأخّراً.'
              : 'Start with tasks in orange and red files — they are the most overdue.',
            ar
              ? 'لا تضع علامة «تم» إلا عند اكتمال العمل فعلاً، لتفادي جولات الإعادة.'
              : 'Only mark Done when the work is truly complete, to avoid send-back rounds.',
            ar
              ? 'اقرأ ملاحظة الإعادة بعناية قبل معاودة العمل على المهمة.'
              : 'Read the send-back note carefully before reworking a task.',
          ]}
        />
      </Section>
    </>
  );
}

/* -------------------------------------------------------------------- styles */

const tabsWrap: CSSProperties = {
  display: 'flex',
  gap: 8,
  marginBlockEnd: 18,
  borderBottom: '1px solid var(--border, #E9E7E0)',
  paddingBlockEnd: 0,
};

function tabStyle(active: boolean): CSSProperties {
  return {
    padding: '9px 16px',
    borderRadius: '8px 8px 0 0',
    border: 'none',
    borderBottom: active ? '2px solid var(--albaker-gold, #BD9446)' : '2px solid transparent',
    background: 'transparent',
    color: active ? 'var(--text-primary, #232220)' : 'var(--text-muted, #93908A)',
    fontWeight: active ? 700 : 500,
    fontSize: 14.5,
    cursor: 'pointer',
  };
}

const sectionCard: CSSProperties = {
  background: 'var(--surface-card, #fff)',
  border: '1px solid var(--border, #E9E7E0)',
  borderRadius: 12,
  padding: 20,
  marginBlockEnd: 14,
};

const sectionTitle: CSSProperties = {
  fontSize: 17,
  fontWeight: 700,
  color: 'var(--text-primary, #232220)',
  margin: '0 0 8px',
};

const paragraph: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: 'var(--text-primary, #3a3833)',
  margin: '0 0 8px',
};

const stepsList: CSSProperties = {
  margin: '4px 0 0',
  paddingInlineStart: 22,
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
};

const stepItem: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.6,
  color: 'var(--text-primary, #3a3833)',
};

function swatch(hex: string): CSSProperties {
  return {
    display: 'inline-block',
    width: 22,
    height: 22,
    borderRadius: 6,
    background: hex,
    border: '1px solid rgba(0,0,0,0.08)',
    flexShrink: 0,
  };
}
