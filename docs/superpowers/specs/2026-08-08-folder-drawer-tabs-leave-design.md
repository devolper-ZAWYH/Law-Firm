# Folder drawer, tabbed detail, and employee leave — design

Date: 2026-08-08
Status: approved

Three changes to the portal, agreed in brainstorming:

1. A folder opens as an overlay drawer pinned to the inline-end edge, not as a
   split-screen pane that squeezes the folder list.
2. The folder detail is reorganised into three tabs — Details, Tasks, Comments.
3. Employees can be booked on leave; while on leave no new task may be assigned
   to them, and those days are recorded as vacation on the attendance sheet.

Every new capability is added to the permissions tree and proven to work both on
its own and as an extra grant to a plain employee.

---

## A. Folder opens as an overlay drawer

### Today

`components/FilesView.tsx:719-750` renders the selected folder inline:

```
<div className="files-sidebar-layout">
  <div className="files-split-content">{content}</div>
  <div className="files-sidebar-main"><FileDetailModal embedded … /></div>
</div>
```

The folder list is compressed into a narrow strip, the detail is a card inside
the page flow (page padding around it, scrolls with the page), and there is no
scrim. A code comment records this as deliberate: the card "sits in the page
rather than floating over a scrim, so there is no modal to dismiss". This design
reverses that decision.

### Wanted

- The active view (kanban / grid / table) always renders at full width. Opening
  a folder never reflows it.
- The detail is an `<aside>` at `position: fixed`, `inset-block: 0`, pinned to
  the **inline-end edge — right in English, left in Arabic**
  (`inset-inline-end: 0`), flush to the viewport with no page padding. The box
  shadow cannot be expressed logically, so it is flipped under `[dir='rtl']`.
- Width `min(560px, 100vw)`; full-width below the existing narrow breakpoint.
- Its own `overflow-y: auto`, independent of the page behind it.
- A dimmed scrim covers the page behind.

### Dismissal

Clicking the scrim closes the folder. Esc closes it. The × closes it. Because it
is now modal, the shell restores `role="dialog"`, `aria-modal="true"`, focus
moves into the drawer on open and returns to the trigger on close, and Tab is
trapped inside.

### Files

- `components/FilesView.tsx` — drop `files-sidebar-layout`; render content
  unconditionally, then the drawer when `selected`.
- `app/globals.css` — replace `.files-sidebar-layout` / `.files-split-content` /
  `.files-sidebar-main` / `.files-detail-embedded` (2176-2222) with
  `.folder-drawer-scrim` and `.folder-drawer`.

---

## B. Folder detail: three tabs

### Today

`components/FileDetailModal.tsx` is 2117 lines and renders one long vertical
scroll: header → folder info → edit form → access → colour bar → move → tasks →
comments → danger zone. Reaching the tasks means scrolling past everything else.

### Wanted

Split into `components/file-detail/`:

| File | Holds |
|---|---|
| `FileDetailDrawer.tsx` | Drawer shell, header, status row, tab switcher |
| `DetailsTab.tsx` | Facts grid, edit-folder form, access, colour status, move, delete |
| `TasksTab.tsx` | Add-task form, Not done / Done lists |
| `CommentsTab.tsx` | Comment log and composer |
| `types.ts` | Props and shared shapes |

`FileDetailModal.tsx` is removed; `FilesView` imports the drawer.

**Header — always visible, above the tabs:** folder icon, `FolderTitle`
(client vs opponent), `#id`, the Drive link when present, ×, and a status row
carrying the section chip, the current colour, and the open-task count.

**Tabs:** `Details` · `Tasks (n)` · `Comments (n)`. Details is selected by
default. The selected tab resets when a different folder is opened (keyed on
`file.id`, as the current `key={selected.id}` already does).

**Language mirroring:** the folder-facts block aligns to the left in Arabic and
the right in English, keyed off `lang` from `useDash()`.

**On-leave banner:** the Details tab shows a red banner for each open task whose
assignee is currently on leave — see feature C.

Behaviour, permissions gating and API calls are carried across unchanged. This
is a reorganisation, not a rewrite of the logic.

---

## C. Employee leave

### Relationship to what exists

`attendance_records.day_status` (migration `20260101000025`) already has
`'vacation'`, but it is **retrospective**: the uploader marks a day on a sheet
that has already been produced. There is nothing forward-looking, and
`createTask` (`lib/platform/tasks.ts:719`) only checks that the assignee is on
the folder or a company manager.

Leave periods are the forward-looking layer, and they write down into the
existing per-day status rather than duplicating it.

### Data

New migration `supabase/migrations/20260101000027_leave_periods.sql`:

```sql
create table if not exists leave_periods (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_users(id) on delete cascade,
  company_id  uuid not null references companies(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,          -- inclusive
  note        text,
  created_by  uuid references app_users(id),
  created_at  timestamptz not null default now(),
  constraint leave_periods_range_chk check (end_date >= start_date)
);
create index if not exists leave_periods_company_range_idx
  on leave_periods (company_id, start_date, end_date);
alter table leave_periods enable row level security;
```

Whole days only — no half-days. Overlapping periods for the same person are
rejected in the service layer with a distinct error code.

Every read degrades to empty and every write to a no-op if the migration has not
been applied (Postgres `42P01` / `42703`), matching the convention in
`lib/platform/notifications.ts`.

### Service layer — `lib/platform/leave.ts`

- `listLeavePeriods(companyId, { userId?, from?, to? })`
- `createLeavePeriod({ companyId, userId, startDate, endDate, note, createdBy })`
- `deleteLeavePeriod(id, companyId)`
- `usersOnLeaveOn(companyId, date): Promise<Map<userId, endDate>>`
- `leaveEndFor(userId, companyId, date): Promise<string | null>`

**Creating a period also marks the attendance days.** For each working day in
the range (respecting the company's working days and the person's own schedule),
upsert an `attendance_records` row with `day_status='vacation'`,
`late_minutes=0`, `early_out_minutes=0`. A day that already carries clock data
is left alone — the sheet is the record of what happened, leave only fills days
that have none.

**Deleting a period** removes only the vacation rows it created — rows with no
`clock_in`/`clock_out`. Days with real data survive.

### Task assignment

- `GET /api/files/[id]/tasks` — each entry in `assignees` gains
  `onLeaveUntil: string | null`.
- `createTask`, `editTask` and `reassignTask` (`lib/platform/tasks.ts`) reject an
  assignee on leave today, returning a new code `assignee_on_leave`. The routes
  translate it to a 409 with a bilingual message naming the return date.
- The assignee `<select>` renders such a person in red as
  `Ahmed Abdulla — on leave until 12 Aug` and disables the option.

Enforced in both places, so the block survives a hand-posted request. There is
no manager override.

### Open tasks keep counting

Leave does not pause the task timer or the folder colour. Instead:

- A new notification type `assignee_on_leave` is sent to the **approver** of
  every open task held by the person, when the leave period is created.
  Bilingual message: *"Ahmed is on leave until 12 Aug — reassign 'Draft the
  response'."*
- The folder's Details tab shows the same warning in red for each affected open
  task.

### Attendance tab

A Leave card in `components/AttendanceView.tsx`: employee picker, start date, end
date, optional note, Add; beneath it a table of current and upcoming periods with
Remove. Shown only to a caller holding `attendance.leave`.

### API

- `GET  /api/companies/[id]/leave` — list (current and upcoming).
- `POST /api/companies/[id]/leave` — create.
- `DELETE /api/companies/[id]/leave/[leaveId]` — remove.

All three require `attendance.leave`. Admin and company managers hold it by
baseline, as elsewhere.

### Permission

One new key in `CAPABILITY_TREE`, under the existing `attendance` group
(`lib/platform/capabilities.ts:167`):

```ts
{
  key: 'attendance.leave',
  en: 'Set leave days for employees',
  ar: 'تحديد أيام إجازة الموظفين',
  hintEn: 'Booked leave blocks new tasks being assigned to that person, and records those days as vacation.',
  hintAr: 'الإجازة المسجلة تمنع إسناد مهام جديدة لهذا الشخص، وتسجل تلك الأيام كإجازة.',
}
```

No legacy boolean — it is enforced through `getExpandedCapabilities` in
`lib/platform/capabilityGrants.ts`, not the `membership_permissions` columns.
The key is permanent and must never be renamed.

---

## Verification

Unit and API tests, in the existing Vitest layout:

| Test | Proves |
|---|---|
| `test/lib/leave-marks-vacation.test.ts` | Creating a period writes `day_status='vacation'` on working days only, and never overwrites a day with clock data |
| `test/lib/leave-blocks-assignment.test.ts` | `createTask` / `editTask` / `reassignTask` return `assignee_on_leave` for someone on leave today, and succeed the day after their leave ends |
| `test/api/leave-capability.test.ts` | An employee **without** `attendance.leave` gets 403 on all three routes; an employee granted **only** `attendance.leave` can create and delete leave, and still cannot upload the attendance sheet or see anyone else's attendance |
| `test/api/leave-approver-notification.test.ts` | Booking leave for someone holding open tasks notifies each task's approver once |
| `test/lib/leave-overlap.test.ts` | Overlapping periods for the same person are rejected |

Then the app is driven in the browser to confirm: the drawer opens pinned right
in both languages without reflowing the list, the scrim and Esc dismiss it, the
three tabs switch, the facts block mirrors by language, and an on-leave employee
appears red and unselectable in the assignee picker.

If the dev server does not come up locally within 60 seconds, verification falls
back to the test suite plus a static render check, and that substitution is
reported rather than glossed over.

## Delivery

On green, the work is pushed to the `testing` remote
(`github.com/AdnanAbdelkarim/law_firm_dashboard_testing`), not to `production`.

## Out of scope

- Half-day or partial-hour leave.
- Employees requesting their own leave for approval.
- Any manager override of the assignment block.
- Pausing task timers or folder colour during leave.
