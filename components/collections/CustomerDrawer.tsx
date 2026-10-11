'use client';

/**
 * A customer file, as a DRAWER over the batch it belongs to.
 *
 * Opening a file used to be a navigation: the whole batch table was replaced by
 * the form, and getting back meant the browser's Back button and a fresh server
 * render of a table you had not left. Working through a batch is a loop — open
 * a file, fill what is missing, return to the list, open the next — and a full
 * page change for each turn of it loses the reader's place every time.
 *
 * The drawer takes HALF the viewport so the batch stays visible beside it: the
 * row you are working on, and the rows still to do, in one view. It follows the
 * text direction, opening on the right in English and the left in Arabic — the
 * same rule the main portal's folder drawer follows, and for the same reason.
 *
 * The /collections/customer/[id] PAGE is still there and still works. A link
 * pasted into a message has no batch to open over, so it renders full width,
 * exactly as before.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import CustomerForm from './CustomerForm';
import { usePaylaterLang } from './PaylaterShell';
import type { PaylaterBatchBrief, PaylaterCustomerFull } from '@/lib/platform/paylater';

export default function CustomerDrawer({
  customerId,
  batches,
  employees,
  canEditFiles,
  canDeleteFiles,
  onClose,
  onSaved,
}: {
  /** The file to open. 'new' is not handled here — creating still has a page. */
  customerId: string;
  batches: PaylaterBatchBrief[];
  employees: { userId: string; name: string }[];
  canEditFiles: boolean;
  /** May remove the file. An admin holds it even when canEditFiles does not. */
  canDeleteFiles: boolean;
  onClose: () => void;
  /** Called after a save, so the batch table behind can pick up the change. */
  onSaved?: () => void;
}) {
  const { ar, dir } = usePaylaterLang();
  const [customer, setCustomer] = useState<PaylaterCustomerFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc closes, as it does on every other overlay in the product.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A pointer-down outside the panel closes it. The scrim itself does not take
  // clicks (see .collections-drawer-scrim), so that clicking another row in the
  // table behind opens THAT file instead of merely dismissing this one.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = panelRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) onClose();
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [onClose]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(
        `/api/paylater/customers/${encodeURIComponent(customerId)}`,
        { cache: 'no-store' }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        customer?: PaylaterCustomerFull;
      };
      if (!res.ok || !data.ok || !data.customer) {
        // A refusal here is the server saying this file is not yours to read.
        // Per the house rule that reads as "not available", not as a breakage.
        setError(
          res.status === 403 || res.status === 404
            ? ar
              ? 'هذا الملف غير متاح لك.'
              : 'That file is not available to you.'
            : ar
              ? 'تعذّر فتح الملف.'
              : 'Could not open the file.'
        );
        return;
      }
      setCustomer(data.customer);
    } catch {
      setError(ar ? 'خطأ في الشبكة.' : 'Network error.');
    }
  }, [customerId, ar]);

  useEffect(() => {
    setCustomer(null);
    void load();
  }, [load]);

  return (
    <>
      <div className="collections-drawer-scrim" aria-hidden="true" />
      <div
        ref={panelRef}
        className="collections-drawer dash-card"
        role="dialog"
        aria-modal="true"
        aria-label={ar ? 'ملف العميل' : 'Customer file'}
        dir={dir}
      >
        <div className="collections-drawer-head">
          <button
            type="button"
            className="dash-btn-ghost collections-drawer-close"
            onClick={onClose}
            aria-label={ar ? 'إغلاق' : 'Close'}
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="dash-alert" role="status">
            {error}
          </div>
        )}

        {!customer && !error && (
          <div className="dash-hint">{ar ? 'جارٍ التحميل…' : 'Loading…'}</div>
        )}

        {customer && (
          <CustomerForm
            customer={customer}
            batchId={customer.batchId}
            batchCode={customer.batchCode}
            batches={batches.map((b) => ({ id: b.id, code: b.code, month: b.month }))}
            employees={employees}
            canEditFiles={canEditFiles}
            canDeleteFiles={canDeleteFiles}
            // Saving returns you to the batch, which is the loop this drawer
            // exists to serve: fill a file, close, open the next. Cancel takes
            // the same path — there is nothing to route to from in here.
            onSaved={() => {
              onSaved?.();
              onClose();
            }}
          />
        )}
      </div>
    </>
  );
}
