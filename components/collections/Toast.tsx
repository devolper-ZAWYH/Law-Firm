'use client';

/**
 * THE ANSWER, IN THE MIDDLE OF THE SCREEN, FOR TWO SECONDS.
 *
 * A reply to "did that save?" has to arrive where the person is looking. It
 * lived at the top of the page first, which on a form eight sections long meant
 * a screen away from the button; then beside the button, which is right until
 * the page has scrolled. Fixed to the VIEWPORT it is in front of them wherever
 * they are.
 *
 * `position: fixed` against the viewport, not the page — the wrapper does not
 * scroll with the document, and `pointer-events: none` on it means the toast
 * never swallows a click meant for the form underneath.
 *
 * IT ANNOUNCES ITSELF. `role="status"` for a success and `role="alert"` for a
 * failure, so a screen reader speaks it rather than leaving somebody with no
 * reply at all — the visual version is gone in two seconds and cannot be
 * gone back to.
 *
 * A FAILURE IS ALSO LEFT IN PLACE by the caller. Two seconds is right for
 * "Saved", which only has to say that something happened; it is not enough for
 * a reason somebody has to act on, and an error that erases itself is how a
 * failed save comes to look like a successful one.
 */

import { useEffect, useRef, useState } from 'react';

export interface ToastMessage {
  text: string;
  kind: 'ok' | 'err';
  /** Distinguishes two identical messages in a row, so the timer restarts. */
  at: number;
}

export default function Toast({
  message,
  onDone,
}: {
  message: ToastMessage | null;
  onDone: () => void;
}) {
  const [leaving, setLeaving] = useState(false);

  /*
    THE CALLBACK LIVES IN A REF, and that is the whole reason this works.

    Callers pass an inline `() => setToast(null)`, which is a NEW function on
    every render of the parent. With it in the dependency list the effect tore
    down and rebuilt its timers on every one of those renders — and a form that
    re-renders as somebody types never let the two seconds elapse, so the toast
    stayed on screen for good. Depending on the message's own identity, and
    reading the callback through a ref, means the clock starts once per message.
  */
  const done = useRef(onDone);
  done.current = onDone;

  const at = message?.at;

  /*
    THE DEADLINE IS ABSOLUTE, counted from when the message was raised rather
    than from when this effect happened to run.

    Saving refreshes the page behind the toast, and that remount restarted a
    relative timer — two seconds became four, every time, in production. An
    end time computed from `at` survives any number of remounts: whatever
    happens in between, the toast disappears two seconds after the thing it is
    reporting actually happened.
  */
  useEffect(() => {
    if (at === undefined) return;
    const VISIBLE = 2000;
    const FADE = 250;
    const untilFade = Math.max(0, at + VISIBLE - Date.now());
    const untilGone = Math.max(0, at + VISIBLE + FADE - Date.now());

    setLeaving(untilFade === 0);
    const fade = window.setTimeout(() => setLeaving(true), untilFade);
    const gone = window.setTimeout(() => done.current(), untilGone);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
    // `at` is stamped per message, so showing the same text twice restarts it.
  }, [at]);

  if (!message) return null;

  return (
    <div className="pl-toast-wrap" aria-live="polite">
      <div
        className={`pl-toast ${message.kind}${leaving ? ' leaving' : ''}`}
        role={message.kind === 'err' ? 'alert' : 'status'}
      >
        {message.text}
      </div>
    </div>
  );
}
