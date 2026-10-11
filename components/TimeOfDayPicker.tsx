'use client';

/**
 * 12-HOUR (AM/PM) TIME PICKER — the portal's only way to enter a time of day.
 *
 * TWO THINGS A NATIVE <input type="time"> GETS WRONG HERE.
 *
 *   1. IT PICKS ITS OWN FORMAT. The browser renders whatever the operating
 *      system's locale says, which is usually 24-hour. These are hours of a
 *      working day, and people say them as "9 AM" and "2:30 PM".
 *   2. IT REVERSES ITSELF IN ARABIC. Inside an RTL page it lays its own
 *      segments right-to-left, so 09:00 displays as "00:09" and 14:30 as
 *      "30:14" — the stored value perfectly correct and the screen unreadable.
 *      This shipped once, on the work-schedule editor.
 *
 * Built from three selects, which do nothing of the kind. Value and onChange
 * speak 'HH:MM' 24h (matching TIME_RE server-side); only the face is 12-hour,
 * so nothing downstream has to know.
 *
 * Lives on its own so every screen that takes a time uses this one — the
 * employee card's working hours and schedule intervals, and the attendance
 * review table's clock-in and clock-out.
 */
export default function TimeOfDayPicker({
  value,
  onChange,
  ar,
  disabled,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  ar: boolean;
  disabled: boolean;
}) {
  let hour12 = 9;
  let minute = 0;
  let period: 'AM' | 'PM' = 'AM';
  if (value) {
    const [hStr, mStr] = value.split(':');
    const h = parseInt(hStr, 10);
    minute = parseInt(mStr, 10) || 0;
    period = h >= 12 ? 'PM' : 'AM';
    hour12 = h % 12 === 0 ? 12 : h % 12;
  }

  function emit(nextHour12: number, nextMinute: number, nextPeriod: 'AM' | 'PM') {
    let h = nextHour12 % 12;
    if (nextPeriod === 'PM') h += 12;
    onChange(`${String(h).padStart(2, '0')}:${String(nextMinute).padStart(2, '0')}`);
  }

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <select
        className="dash-input"
        aria-label={ar ? 'الساعة' : 'Hour'}
        dir="ltr"
        disabled={disabled}
        value={value ? hour12 : ''}
        onChange={(e) => {
          if (!e.target.value) {
            onChange(null);
            return;
          }
          emit(Number(e.target.value), minute, period);
        }}
      >
        <option value="">{'—'}</option>
        {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <select
        className="dash-input"
        aria-label={ar ? 'الدقيقة' : 'Minute'}
        dir="ltr"
        disabled={disabled || !value}
        value={minute}
        onChange={(e) => emit(hour12, Number(e.target.value), period)}
      >
        {Array.from({ length: 60 }, (_, i) => i).map((m) => (
          <option key={m} value={m}>
            {String(m).padStart(2, '0')}
          </option>
        ))}
      </select>
      <select
        className="dash-input"
        aria-label={ar ? 'ص/م' : 'AM/PM'}
        dir="ltr"
        disabled={disabled || !value}
        value={period}
        onChange={(e) => emit(hour12, minute, e.target.value === 'PM' ? 'PM' : 'AM')}
      >
        <option value="AM">{ar ? 'ص' : 'AM'}</option>
        <option value="PM">{ar ? 'م' : 'PM'}</option>
      </select>
    </div>
  );
}
