/**
 * SUGGESTING A GENDER, AND WHY IT IS NOT READ FROM THE QID.
 *
 * The obvious idea is that a Qatari QID encodes gender, the way some national
 * ID schemes do. It does not. The number is
 *
 *     C YY NNN SSSSS
 *     │  │   │     └── serial
 *     │  │   └──────── ISO-3166 country code (634 Qatar, 840 USA, 736 Sudan…)
 *     │  └──────────── year of birth
 *     └─────────────── century
 *
 * and none of it carries sex. That was tested rather than assumed, against 96
 * files in this database whose Arabic given name is unambiguous: serial parity
 * agreed with the name 53% of the time — a coin flip — and EVERY digit
 * position, scored at its best possible split, landed exactly on the 83.3%
 * you get by ignoring the number and always answering "male". There is no
 * signal to read. (Four seeded records in the v2 prototype happen to fit a
 * parity rule; that is coincidence, and worth knowing about before someone
 * rediscovers it.)
 *
 * The customer report does not carry it either — 73 reports were parsed and
 * none names a gender — and the ID card PDF is an image with only "QID: …" and
 * the name in its text layer.
 *
 * WHAT IS LEFT IS THE NAME, which is real information but not proof. So this
 * SUGGESTS, and the form still asks a person to confirm — which is what v2's
 * "يتطلب تأكيد" chip meant. The value is only ever written by someone
 * accepting it.
 *
 * Only unambiguous given names are listed. A name that is used for both, or
 * that this list does not know, returns null and the field stays empty: an
 * empty field asks a question, while a wrong guess answers it, and the answer
 * ends up in the salutation on a legal notice.
 */

export type Gender = 'male' | 'female';

/**
 * Arabic given names, first-name position only. Spelling variants are listed
 * separately rather than normalised — ة/ه and ي/ى differ across the source
 * spreadsheets, and folding them by rule would also fold names that genuinely
 * differ.
 */
const MALE = new Set([
  'محمد', 'محمّد', 'احمد', 'أحمد', 'علي', 'على', 'عبدالله', 'عبد', 'عبدالرحمن',
  'عبدالعزيز', 'عبدالرحيم', 'عبداللطيف', 'خالد', 'سالم', 'سعد', 'سعيد', 'حسن',
  'حسين', 'ابراهيم', 'إبراهيم', 'يوسف', 'عمر', 'جاسم', 'ناصر', 'فهد', 'سلطان',
  'طلال', 'بدر', 'ماجد', 'حمد', 'حمدان', 'راشد', 'سليمان', 'مصطفي', 'مصطفى',
  'عادل', 'وليد', 'طارق', 'زياد', 'انور', 'أنور', 'مبارك', 'فيصل', 'عيسى',
  'موسى', 'يعقوب', 'اسماعيل', 'إسماعيل', 'كمال', 'جمال', 'صالح', 'عثمان',
  'مشعل', 'نايف', 'ثامر', 'سيف', 'غانم', 'مانع', 'جابر', 'عبدالكريم', 'يحيى', 'ادريس', 'إدريس', 'زايد', 'مهدي', 'كريم', 'رامي', 'سامي', 'باسم',
  'عماد', 'اياد', 'إياد', 'هيثم', 'اشرف', 'أشرف', 'شريف', 'صابر', 'عصام',
  'نبيل', 'وائل', 'ياسر', 'امجد', 'أمجد', 'خليفة', 'فالح', 'مطر', 'سند',
]);

const FEMALE = new Set([
  'فاطمة', 'فاطمه', 'نورة', 'نوره', 'نور', 'مريم', 'عائشة', 'عائشه', 'هند',
  'منى', 'مني', 'اسماء', 'أسماء', 'سارة', 'ساره', 'لطيفة', 'لطيفه', 'موزة',
  'موزه', 'شيخة', 'شيخه', 'حصة', 'حصه', 'امل', 'أمل', 'ريم', 'دانة', 'دانه',
  'الجازي', 'شمة', 'شمه', 'مها', 'هيا', 'نجلاء', 'سميرة', 'سميره', 'خديجة',
  'خديجه', 'عليا', 'جواهر', 'بدرية', 'بدريه', 'صالحة', 'صالحه', 'حمدة', 'حمده',
  'سعاد', 'ابتسام', 'وضحى', 'منيرة', 'منيره', 'عبير', 'رنا', 'ريما', 'هدى',
  'هيفاء', 'سلمى', 'ليلى', 'زينب', 'رقية', 'رقيه', 'سميه', 'سمية', 'حنان',
  'ايمان', 'إيمان', 'اميرة', 'أميرة', 'نادية', 'ناديه', 'وفاء', 'شيماء',
  'غادة', 'غاده', 'رابعة', 'رابعه', 'الانود', 'العنود', 'مضاوي', 'شهد',
  'جوهرة', 'جوهره', 'نوف', 'دلال', 'اسيل', 'أسيل', 'بشاير', 'روان', 'لولوة',
  'لولوه', 'مي', 'ميثاء', 'عذاري', 'عهود', 'افنان', 'أفنان',
]);

/**
 * A suggestion from the Arabic name, or null when the name is not one this
 * list knows. Never call this a value: the caller must present it as something
 * to confirm.
 */
export function suggestGender(nameAr: string | null): Gender | null {
  const first = (nameAr ?? '').trim().split(/\s+/)[0];
  if (!first) return null;
  if (MALE.has(first)) return 'male';
  if (FEMALE.has(first)) return 'female';
  return null;
}

/**
 * Deliberately exported so a test can assert the two lists never overlap. A
 * name in both would make the suggestion depend on lookup order, which is the
 * kind of thing that goes unnoticed for a year.
 */
export const GENDER_NAMES = { MALE, FEMALE };
