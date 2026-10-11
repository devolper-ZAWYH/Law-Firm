'use client';

import { useEffect, useRef, useState } from 'react';
import { taskInitial, taskPersonName, type TaskPersonWithCapacity } from './taskTypes';

/**
 * WHOSE WORK TO SHOW — a multi-select over the company roster.
 *
 * It was a single `<select>`, which could answer "everyone" or "one person" and
 * nothing in between. The question a manager actually has is usually about a
 * FEW people: the two who share a matter, the three on a filing. Everyone is
 * too noisy to read and one at a time cannot be compared, so the useful case
 * was the one the control could not express.
 *
 * NOT a native `<select multiple>`. That renders as a scrolling list box that
 * is always open, takes as much vertical space as it has options, and requires
 * ctrl/cmd-click to add a second selection — a convention most people do not
 * know and cannot discover. A popover of checkboxes says what it does.
 *
 * EMPTY MEANS EVERYONE. Not "nobody": a filter that has been cleared is a
 * filter that is off, and a calendar showing zero rows because you unticked the
 * last person is a screen that looks broken. Clearing is therefore the same act
 * as selecting all, and the control says "All employees" in that state.
 */
export interface PeopleFilterProps {
  people: TaskPersonWithCapacity[];
  /** Selected user ids. EMPTY = everyone (see above). */
  selected: string[];
  onChange: (ids: string[]) => void;
  lang: 'en' | 'ar';
}

export default function PeopleFilter({
  people,
  selected,
  onChange,
  lang,
}: PeopleFilterProps) {
  const ar = lang === 'ar';
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      const target = e.target;
      if (root && target instanceof Node && !root.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle(userId: string) {
    onChange(
      selected.includes(userId)
        ? selected.filter((id) => id !== userId)
        : [...selected, userId]
    );
  }

  /**
   * What the closed control says. One name when exactly one is picked — the
   * common case, and "1 selected" would make you open it to find out who.
   */
  const label = (() => {
    if (selected.length === 0) return ar ? 'كل الموظفين' : 'All employees';
    if (selected.length === 1) {
      const p = people.find((x) => x.userId === selected[0]);
      return p ? taskPersonName(p, lang) : ar ? 'موظف واحد' : '1 selected';
    }
    return ar
      ? `${selected.length} موظفين`
      : `${selected.length} employees`;
  })();

  return (
    <div className="people-filter" ref={rootRef}>
      <button
        type="button"
        className="dash-input people-filter-btn"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="people-filter-label" dir="auto">
          {label}
        </span>
        <span className="people-filter-caret" aria-hidden="true">
          ⌄
        </span>
      </button>

      {open && (
        <div
          className="people-filter-menu"
          role="group"
          aria-label={ar ? 'تصفية حسب الموظف' : 'Filter by employee'}
        >
          <div className="people-filter-actions">
            <button
              type="button"
              className="dash-btn-ghost"
              onClick={() => onChange([])}
              disabled={selected.length === 0}
            >
              {ar ? 'الكل' : 'All'}
            </button>
            <button
              type="button"
              className="dash-btn-ghost"
              onClick={() => onChange(people.map((p) => p.userId))}
            >
              {ar ? 'تحديد الجميع' : 'Select all'}
            </button>
          </div>
          <ul className="people-filter-list">
            {people.map((p) => {
              const name = taskPersonName(p, lang);
              const checked = selected.includes(p.userId);
              return (
                <li key={p.userId}>
                  <label className="people-filter-row">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(p.userId)}
                    />
                    <span className="access-avatar" aria-hidden="true">
                      {taskInitial(name)}
                    </span>
                    <span className="people-filter-name" dir="auto">
                      {name}
                    </span>
                    {/* The daily hours their bars are measured against —
                        useful here because it is what makes one person's day
                        look fuller than another's. */}
                    <span className="people-filter-cap" dir="ltr">
                      {p.capacityHours ?? '—'}h
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
