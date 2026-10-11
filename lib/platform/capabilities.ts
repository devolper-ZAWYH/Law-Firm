/**
 * CAPABILITIES — everything a manager can do that a plain employee cannot,
 * broken into individually grantable pieces.
 *
 * CLIENT-SAFE (no `server-only`): the employee edit card renders this tree, and
 * the server resolves permission from the same definitions. One list, so the UI
 * can never offer a switch the server does not honour.
 *
 * THE SHAPE — three levels, because that is how people describe the work:
 *
 *   GROUP            Files
 *     CAPABILITY       Edit a folder
 *       SUB            …change the client / opponent
 *       SUB            …move it between sections
 *
 * A parent is granted implicitly when any child is: `files.edit` is "may edit
 * something", and its children say what. Checking a parent in the UI checks its
 * children; that is presentation, but the resolution below relies on it — see
 * expandCapabilities.
 *
 * WHOLESALE FOLDER VISIBILITY IS PER SECTION, and it is the one place the
 * parent key is NOT what the server checks.
 *
 * expandCapabilities deliberately expands child → parent as well as parent →
 * child, because routes normally enforce the coarse parent. That rule would be
 * a hole here: granting only "…every Expired folder" would imply
 * 'files.viewAll', and an employee allowed to see closed matters would see
 * every live one too — the exact opposite of the grant.
 *
 * So nothing enforces 'files.viewAll'. It is a presentation parent: ticking it
 * ticks its four children, and the server asks only about
 * 'files.viewAll.<section>', one per column of the Folders board. Expansion
 * still runs in both directions, and remains harmless — the implied parent is
 * a key no code reads.
 *
 * An existing stored grant of the bare 'files.viewAll' keeps working: it
 * expands DOWN to all four sections, which is what it always meant.
 *
 * KEYS ARE PERMANENT. They are stored per membership, so renaming one silently
 * revokes access. Add new keys; never repurpose an old one.
 *
 * LEGACY. Six boolean columns predate this (membership_permissions.can_*).
 * Each maps to a key via LEGACY_CAPABILITY_MAP, and a granted boolean still
 * satisfies its key, so nothing that works today stops working.
 */

export type CapabilityKey = string;

export interface CapabilityNode {
  key: CapabilityKey;
  en: string;
  ar: string;
  /** Shown under the label when the consequence is not obvious from the name. */
  hintEn?: string;
  hintAr?: string;
  children?: CapabilityNode[];
}

export interface CapabilityGroup {
  key: string;
  en: string;
  ar: string;
  hintEn?: string;
  hintAr?: string;
  capabilities: CapabilityNode[];
}

/**
 * The full tree. Derived by auditing every place the API grants something to a
 * manager that it withholds from an employee.
 */
export const CAPABILITY_TREE: CapabilityGroup[] = [
  {
    key: 'files',
    en: 'Folders',
    ar: 'المجلدات',
    hintEn: 'Client matters — what they may see and change.',
    hintAr: 'ملفات العملاء — ما يمكنه رؤيته وتغييره.',
    capabilities: [
      {
        // PRESENTATION PARENT — see the note on files.viewAll.* below. The
        // server never enforces this key; it enforces the four section keys
        // under it, one per column of the Folders board.
        key: 'files.viewAll',
        en: 'See every folder in the company',
        ar: 'رؤية كل مجلدات الشركة',
        hintEn:
          'Without this an employee only sees folders assigned to them. Tick the whole row for every folder, or just the sections they should see.',
        hintAr:
          'بدونها يرى الموظف المجلدات المسندة إليه فقط. حدّد الصف كاملاً لرؤية كل المجلدات، أو الأقسام التي يُسمح له برؤيتها فقط.',
        children: [
          {
            key: 'files.viewAll.potential',
            en: '…every Potential folder',
            ar: '…كل المجلدات المحتملة',
          },
          {
            key: 'files.viewAll.active',
            en: '…every Active folder',
            ar: '…كل المجلدات النشطة',
          },
          {
            key: 'files.viewAll.expired',
            en: '…every Expired folder',
            ar: '…كل المجلدات المنتهية',
          },
          {
            key: 'files.viewAll.attrition',
            en: '…every Attrition folder',
            ar: '…كل مجلدات التسرب',
          },
        ],
      },
      { key: 'files.create', en: 'Create a folder', ar: 'إنشاء مجلد' },
      {
        key: 'files.edit',
        en: 'Edit a folder',
        ar: 'تعديل مجلد',
        children: [
          { key: 'files.edit.client', en: 'Change the client', ar: 'تغيير العميل' },
          { key: 'files.edit.opponent', en: 'Change the opponent', ar: 'تغيير الخصم' },
          { key: 'files.edit.type', en: 'Change the folder type', ar: 'تغيير نوع المجلد' },
          { key: 'files.edit.leader', en: 'Change the folder leader', ar: 'تغيير مسؤول المجلد' },
          { key: 'files.edit.driveLink', en: 'Change the Drive link', ar: 'تغيير رابط درايف' },
        ],
      },
      {
        key: 'files.move',
        en: 'Move a folder between sections',
        ar: 'نقل مجلد بين الأقسام',
        children: [
          { key: 'files.move.active', en: 'Potential → Active', ar: 'محتمل ← نشط' },
          { key: 'files.move.expired', en: 'Mark as Expired (closed)', ar: 'وضع كمنتهٍ (مغلق)' },
          {
            key: 'files.move.attrition',
            en: 'Mark as Attrition (client lost)',
            ar: 'وضع كمتسرب (فقدان العميل)',
            hintEn: 'Stops the folder counting — its tasks stay but no longer run.',
            hintAr: 'يوقف احتساب المجلد — تبقى المهام لكنها تتوقف.',
          },
        ],
      },
      {
        key: 'files.caseDetails',
        en: 'Set the case number, court and level',
        ar: 'تحديد رقم القضية والمحكمة والدرجة',
        hintEn:
          'Only these three fields. Deliberately separate from "Edit a folder" — a permission to record the case number is not a permission to rewrite who the client is.',
        hintAr:
          'هذه الحقول الثلاثة فقط. منفصلة عمدًا عن «تعديل مجلد» — صلاحية تسجيل رقم القضية ليست صلاحية تغيير هوية العميل.',
      },
      {
        key: 'files.delete',
        en: 'Delete a folder',
        ar: 'حذف مجلد',
        hintEn: 'Permanent, and takes the folder’s tasks, comments and history with it.',
        hintAr: 'نهائي، ويحذف معه مهام المجلد وتعليقاته وسجله.',
      },
      {
        key: 'files.comments',
        en: 'Comments on a folder',
        ar: 'التعليقات على المجلد',
        children: [
          { key: 'files.comments.read', en: 'Read comments', ar: 'قراءة التعليقات' },
          { key: 'files.comments.add', en: 'Add a comment', ar: 'إضافة تعليق' },
          { key: 'files.comments.mention', en: 'Mention colleagues', ar: 'الإشارة إلى الزملاء' },
        ],
      },
      {
        key: 'files.summary',
        en: 'Write the folder summary',
        ar: 'كتابة ملخص المجلد',
        hintEn:
          'The one standing description of the matter. Managers and admins always have it; grant it to an employee who should keep it current.',
        hintAr:
          'الوصف الثابت الوحيد للملف. المديرون والمسؤولون لديهم هذه الصلاحية دائمًا؛ امنحها لموظف يتولى تحديثه.',
      },
      {
        key: 'files.access',
        en: 'Who is on a folder',
        ar: 'من لديه صلاحية على المجلد',
        children: [
          { key: 'files.access.view', en: 'See who has access', ar: 'رؤية من لديه صلاحية' },
          { key: 'files.access.add', en: 'Request to add someone', ar: 'طلب إضافة شخص' },
          { key: 'files.access.remove', en: 'Remove someone', ar: 'إزالة شخص' },
        ],
      },
    ],
  },
  {
    key: 'tasks',
    en: 'Tasks',
    ar: 'المهام',
    hintEn: 'Assigning work and signing it off.',
    hintAr: 'إسناد العمل واعتماده.',
    capabilities: [
      {
        key: 'tasks.viewOnFolder',
        en: 'See a folder’s tasks',
        ar: 'رؤية مهام المجلد',
      },
      {
        key: 'tasks.create',
        en: 'Create and assign a task',
        ar: 'إنشاء مهمة وإسنادها',
      },
      {
        key: 'tasks.edit',
        en: 'Edit a task',
        ar: 'تعديل مهمة',
        children: [
          { key: 'tasks.edit.details', en: 'Change title / description', ar: 'تغيير العنوان أو الوصف' },
          { key: 'tasks.edit.reassign', en: 'Reassign to someone else', ar: 'إعادة الإسناد لشخص آخر' },
          { key: 'tasks.edit.approver', en: 'Change the approver', ar: 'تغيير المعتمد' },
        ],
      },
      {
        key: 'tasks.delete',
        en: 'Delete a task',
        ar: 'حذف مهمة',
        hintEn:
          'Permanent, and destroys the task’s history — its events, notes and the record that the work was ever asked for. Pair it with "requires approval" unless you mean to hand that over outright.',
        hintAr:
          'نهائي، ويحذف سجل المهمة — أحداثها وملاحظاتها وسجل طلبها أصلًا. اقرنها بـ«تتطلب موافقة» ما لم تقصد منحها بالكامل.',
      },
      {
        key: 'tasks.overview',
        en: 'See everyone’s open tasks',
        ar: 'رؤية المهام المفتوحة للجميع',
        hintEn: 'The company-wide "who is working on what" view.',
        hintAr: 'عرض «من يعمل على ماذا» على مستوى الشركة.',
      },
    ],
  },
  {
    key: 'attendance',
    en: 'Attendance',
    ar: 'الحضور',
    capabilities: [
      {
        key: 'attendance.upload',
        en: 'Upload the attendance sheet',
        ar: 'رفع كشف الحضور',
        children: [
          {
            key: 'attendance.upload.mark',
            en: 'Mark days absent / vacation',
            ar: 'تعليم الأيام كغياب أو إجازة',
          },
          {
            key: 'attendance.upload.overwrite',
            en: 'Overwrite already-recorded days',
            ar: 'استبدال أيام مسجلة مسبقًا',
          },
        ],
      },
      {
        key: 'attendance.viewAll',
        en: 'See everyone’s attendance',
        ar: 'رؤية حضور الجميع',
        hintEn: 'Without this a person only ever sees their own.',
        hintAr: 'بدونها يرى الشخص حضوره فقط.',
      },
      {
        key: 'attendance.objection',
        en: 'Object to attendance on the uploaded sheet',
        ar: 'الاعتراض على الحضور في الكشف المرفوع',
        hintEn:
          'Adds an Objection button to the review table shown after an attendance file is uploaded, asking the designated manager to remove time from a day. Set that manager in Company settings.',
        hintAr:
          'يضيف زر اعتراض في جدول المراجعة الذي يظهر بعد رفع ملف الحضور، لطلب خصم وقت من يوم معيّن من المدير المعيَّن. يُحدَّد ذلك المدير في إعدادات الشركة.',
      },
      {
        key: 'attendance.leave',
        en: 'Set leave days for employees',
        ar: 'تحديد أيام إجازة الموظفين',
        hintEn:
          'Booked leave blocks new tasks being assigned to that person, and records those days as vacation.',
        hintAr:
          'الإجازة المسجلة تمنع إسناد مهام جديدة لهذا الشخص، وتسجل تلك الأيام كإجازة.',
      },
    ],
  },
  {
    key: 'people',
    en: 'People',
    ar: 'الموظفون',
    hintEn:
      'Account-level actions (password, role, freeze, removal) stay with the admin and are not grantable.',
    hintAr:
      'إجراءات الحساب (كلمة المرور، الدور، التجميد، الإزالة) تبقى للمسؤول ولا يمكن منحها.',
    capabilities: [
      { key: 'people.view', en: 'See the employees list', ar: 'رؤية قائمة الموظفين' },
      {
        key: 'people.schedule',
        en: 'Set working days and hours',
        ar: 'تحديد أيام وساعات العمل',
        hintEn: 'These drive how lateness is measured for that person.',
        hintAr: 'تُحدد بها طريقة احتساب التأخير لهذا الشخص.',
      },
      {
        key: 'people.zkteco',
        en: 'Set the attendance-device ID',
        ar: 'تحديد رقم جهاز الحضور',
      },
      {
        key: 'people.permissions',
        en: 'Grant these permissions to others',
        ar: 'منح هذه الصلاحيات للآخرين',
        hintEn: 'Lets them hand out anything on this page. Nobody may grant to themselves.',
        hintAr: 'يتيح له منح أي شيء في هذه الصفحة. لا يمكن لأحد المنح لنفسه.',
      },
    ],
  },
  {
    key: 'company',
    en: 'Company',
    ar: 'الشركة',
    capabilities: [
      {
        key: 'company.settingsView',
        en: 'View company settings',
        ar: 'عرض إعدادات الشركة',
        hintEn: 'Working days and colour pace. Telegram credentials stay admin-only.',
        hintAr: 'أيام العمل وسرعة الألوان. تبقى بيانات تيليجرام للمسؤول فقط.',
      },
      {
        key: 'company.folderTypes',
        en: 'Add folder types',
        ar: 'إضافة أنواع المجلدات',
      },
      {
        key: 'company.contacts',
        en: 'See the client directory',
        ar: 'رؤية دليل العملاء',
      },
      // Deliberately a SIBLING of company.contacts, not a child of it: children
      // are implied by their parent (see expandCapabilities), so nesting this
      // under "See the client directory" would hand write access to everyone
      // who was only meant to read it. The same reasoning keeps
      // company.contactsEdit a sibling of BOTH of them.
      {
        key: 'company.contactsAdd',
        en: 'Add someone to the client directory',
        ar: 'إضافة شخص إلى دليل العملاء',
        hintEn: 'Creating a CRM contact. Reading the directory is the separate grant above.',
        hintAr: 'إنشاء جهة اتصال في دليل العملاء. قراءة الدليل صلاحية منفصلة أعلاه.',
      },
      {
        key: 'company.contactsEdit',
        en: 'Edit someone in the client directory',
        ar: 'تعديل جهة اتصال في دليل العملاء',
        hintEn:
          'Changing an existing contact’s name, phone, email or notes. Managers always have it; grant it to an employee who keeps the directory current. Deleting a contact stays with the admin.',
        hintAr:
          'تغيير اسم جهة اتصال قائمة أو هاتفها أو بريدها أو ملاحظاتها. المديرون لديهم هذه الصلاحية دائمًا؛ امنحها لموظف يتولى تحديث الدليل. حذف جهة الاتصال يبقى للمسؤول.',
      },
    ],
  },
  {
    key: 'notifications',
    en: 'Notifications',
    ar: 'الإشعارات',
    hintEn:
      'What this person is told about. These grant no power to act — only to be informed.',
    hintAr: 'ما يُبلَّغ به هذا الشخص. لا تمنح أي صلاحية تنفيذ — فقط الإطلاع.',
    capabilities: [
      {
        key: 'notifications.overdue',
        en: 'Overdue folder alerts',
        ar: 'تنبيهات المجلدات المتأخرة',
        hintEn: 'The red/critical alerts managers receive.',
        hintAr: 'التنبيهات الحمراء/الحرجة التي يتلقاها المديرون.',
      },
      // NOTE: 'notifications.attendanceObjections' used to sit here — an
      // employee picked which managers to notify about their own attendance.
      // Objections are now raised by the sheet uploader and always go to the
      // ONE approver the admin designates in Company settings, so there is
      // nobody left to opt into. Existing grants of the old key are simply
      // ignored (isCapabilityKey rejects it, so it never expands to anything).
      {
        key: 'notifications.taskDone',
        en: 'Task marked done',
        ar: 'إنجاز المهام',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// PAYLATER ROLES ARE NOT CAPABILITIES — do not add them back here.
//
// A 'paylater' group briefly lived above, with the four roles as four
// independent capabilities. It was wrong, and the UI showed why: nothing
// stopped one person being ticked as both Lawyer and Auditor, who in the case
// journey exist to check each other's work.
//
// This tree is for ADDITIVE grants — things a person may do, which stack. The
// four PayLater roles are MUTUALLY EXCLUSIVE jobs, and that is not expressible
// here: expandCapabilities runs in both directions, so any grouping of them
// either implies all four or implies a parent nobody granted (the same trap
// documented for files.viewAll at the top of this file).
//
// The role now lives on memberships.paylater_role — a single-valued column, so
// two roles are not merely discouraged but unrepresentable. The list is in
// lib/platform/paylaterRoles.ts and the dropdown sits at the top of the
// Employees card, beside the Manager/Employee role it resembles.
//
// Migration #35 drops any stored 'paylater.%' grants.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Approval gating
// ---------------------------------------------------------------------------

/**
 * The kinds of action that can be PARKED and replayed later. Each one has
 * exactly one executor registered in lib/platform/approvalExecutors.ts; the
 * name is stored in capability_approval_requests.action_type, so — like
 * capability keys — these strings are PERMANENT. Renaming one strands every
 * pending request that carries the old name.
 */
export type ApprovalActionType =
  | 'task.create'
  | 'task.delete'
  | 'task.edit'
  | 'file.create'
  | 'file.delete'
  | 'file.move'
  | 'file.edit'
  | 'file.caseDetails'
  | 'file.summary'
  | 'comment.add'
  | 'contact.create'
  | 'contact.edit'
  | 'folderType.create'
  | 'access.add'
  | 'access.remove'
  | 'leave.set'
  | 'people.schedule'
  | 'people.zkteco'
  | 'people.permissions'
  | 'attendance.upload';

/**
 * Which capabilities may be handed out in "requires approval" form, and what
 * gets replayed when the approver says yes.
 *
 * TWO RULES DECIDE MEMBERSHIP, and both must hold:
 *
 *   1. The capability MUTATES something. Gating a read ("See everyone's
 *      attendance") would mean holding a page load for a human decision, which
 *      is not a thing anyone wants; those grants stay instant.
 *   2. An executor exists for it. The UI reads this map to decide which rows
 *      get an approval toggle, so a capability listed here without a working
 *      executor would be a switch the server cannot honour — precisely what
 *      the one-list rule in this file's header exists to prevent.
 *
 * Every key here is a TOP-LEVEL capability, which is what the enforcing routes
 * check. Extending the gate to another action is: add the key here, add its
 * executor, and have the route call requireApprovalOrRun.
 */
export const APPROVAL_ACTION_BY_CAPABILITY: Record<string, ApprovalActionType> = {
  'tasks.create': 'task.create',
  'tasks.delete': 'task.delete',
  // A child maps to the SAME action as its parent: the route enforces the
  // coarse key, so granting only "Reassign to someone else" must be gateable
  // through exactly the action that carries it out.
  'tasks.edit': 'task.edit',
  'tasks.edit.details': 'task.edit',
  'tasks.edit.reassign': 'task.edit',
  'tasks.edit.approver': 'task.edit',

  'files.create': 'file.create',
  'files.delete': 'file.delete',
  'files.move': 'file.move',
  'files.move.active': 'file.move',
  'files.move.expired': 'file.move',
  'files.move.attrition': 'file.move',
  'files.edit': 'file.edit',
  'files.edit.client': 'file.edit',
  'files.edit.opponent': 'file.edit',
  'files.edit.type': 'file.edit',
  'files.edit.leader': 'file.edit',
  'files.edit.driveLink': 'file.edit',
  'files.caseDetails': 'file.caseDetails',
  'files.summary': 'file.summary',
  'files.comments': 'comment.add',
  'files.comments.add': 'comment.add',
  'files.comments.mention': 'comment.add',

  'files.access': 'access.add',
  'files.access.add': 'access.add',
  'files.access.remove': 'access.remove',

  'attendance.leave': 'leave.set',
  // The sheet import and any objections raised from its review table are one
  // action: applying half a sheet is not a state worth leaving anything in.
  'attendance.upload': 'attendance.upload',
  'attendance.upload.mark': 'attendance.upload',
  'attendance.upload.overwrite': 'attendance.upload',
  'attendance.objection': 'attendance.upload',

  'people.schedule': 'people.schedule',
  'people.zkteco': 'people.zkteco',
  'people.permissions': 'people.permissions',

  'company.contactsAdd': 'contact.create',
  'company.contactsEdit': 'contact.edit',
  'company.folderTypes': 'folderType.create',
};

/** May this capability be granted in "requires approval" form? */
export function isApprovableCapability(key: CapabilityKey): boolean {
  return Object.prototype.hasOwnProperty.call(APPROVAL_ACTION_BY_CAPABILITY, key);
}

/** Every approvable capability key, in tree order. */
export function approvableCapabilityKeys(): CapabilityKey[] {
  return allCapabilityKeys().filter(isApprovableCapability);
}

// ---------------------------------------------------------------------------
// Flattening + resolution
// ---------------------------------------------------------------------------

/** Every key in the tree, parents included, in display order. */
export function allCapabilityKeys(): CapabilityKey[] {
  const out: CapabilityKey[] = [];
  const walk = (nodes: CapabilityNode[]) => {
    for (const n of nodes) {
      out.push(n.key);
      if (n.children) walk(n.children);
    }
  };
  for (const g of CAPABILITY_TREE) walk(g.capabilities);
  return out;
}

const ALL_KEYS = new Set(allCapabilityKeys());

export function isCapabilityKey(value: unknown): value is CapabilityKey {
  return typeof value === 'string' && ALL_KEYS.has(value);
}

/** Direct children of a key, or [] for a leaf. */
export function childrenOf(key: CapabilityKey): CapabilityKey[] {
  const find = (nodes: CapabilityNode[]): CapabilityNode | null => {
    for (const n of nodes) {
      if (n.key === key) return n;
      if (n.children) {
        const hit = find(n.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const g of CAPABILITY_TREE) {
    const node = find(g.capabilities);
    if (node) return (node.children ?? []).map((c) => c.key);
  }
  return [];
}

/** key → its direct parent key, or undefined for a top-level capability. */
const PARENT_OF: Record<CapabilityKey, CapabilityKey | undefined> = (() => {
  const map: Record<CapabilityKey, CapabilityKey | undefined> = {};
  const walk = (nodes: CapabilityNode[], parent: CapabilityKey | undefined) => {
    for (const n of nodes) {
      map[n.key] = parent;
      if (n.children) walk(n.children, n.key);
    }
  };
  for (const g of CAPABILITY_TREE) walk(g.capabilities, undefined);
  return map;
})();

/** Every ancestor of `key`, nearest first, or [] for a top-level capability. */
function ancestorsOf(key: CapabilityKey): CapabilityKey[] {
  const out: CapabilityKey[] = [];
  let cur = PARENT_OF[key];
  while (cur) {
    out.push(cur);
    cur = PARENT_OF[cur];
  }
  return out;
}

/**
 * The six legacy booleans, each as the key it now means. A granted boolean
 * still satisfies its key, so existing grants keep working untouched.
 */
export const LEGACY_CAPABILITY_MAP: Record<string, CapabilityKey> = {
  can_create_file: 'files.create',
  can_edit_file: 'files.edit',
  can_delete_file: 'files.delete',
  can_move_file_section: 'files.move',
  can_create_task: 'tasks.create',
  can_manage_file_access: 'files.access',
  can_upload_attendance: 'attendance.upload',
};

/**
 * Expand a stored grant list into everything it implies — in BOTH directions:
 *
 *   • PARENT → children: "may edit a folder" without any child checked would
 *     otherwise be a switch that does nothing. Expanding here rather than at
 *     write time means a capability added to the tree later is picked up by
 *     existing grants instead of needing a backfill.
 *   • child → PARENT: server enforcement only ever checks the coarse parent
 *     key (no route enforces an individual leaf sub-permission like "change
 *     the approver" on its own — the whole task/folder action is all-or-
 *     nothing). So checking only a child box ("Reassign to someone else")
 *     without its parent ("Edit a task") must still satisfy the parent, or
 *     that grant would silently have no effect at all.
 */
export function expandCapabilities(granted: Iterable<CapabilityKey>): Set<CapabilityKey> {
  const out = new Set<CapabilityKey>();
  const addDown = (key: CapabilityKey) => {
    if (out.has(key)) return;
    out.add(key);
    for (const child of childrenOf(key)) addDown(child);
  };
  for (const key of granted) {
    if (!isCapabilityKey(key)) continue;
    addDown(key);
    for (const ancestor of ancestorsOf(key)) out.add(ancestor);
  }
  return out;
}

/**
 * Does this grant list satisfy `needed`?
 *
 * A parent satisfies its children (see expandCapabilities), so a route asking
 * for 'files.edit.client' is answered by a grant of either that key or
 * 'files.edit'.
 */
export function hasCapability(
  granted: Iterable<CapabilityKey>,
  needed: CapabilityKey
): boolean {
  return expandCapabilities(granted).has(needed);
}
