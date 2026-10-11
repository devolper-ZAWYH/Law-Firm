'use client';

/**
 * Search across all files — name in either language, QID, case number or
 * enforcement number.
 *
 * A QID search deliberately matches wider than the stored value: 258 imported
 * records carry a trailing zero a real QID card does not have, and someone
 * holding the card should still find the file. See searchCustomers.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePaylaterLang } from './PaylaterShell';
import type { PaylaterCustomerRow } from '@/lib/platform/paylater';

export default function SearchView({
  query,
  results,
}: {
  query: string;
  results: (PaylaterCustomerRow & { batchCode: string })[];
}) {
  // One language for the whole portal, owned by the shell.
  const { lang, t, dir } = usePaylaterLang();
  const router = useRouter();
  const [q, setQ] = useState(query);

  return (
    <div dir={dir}>
      <div className="dash-page-head">
        <div>
          <h1 className="dash-title">{t.plSearch}</h1>
        </div>
      </div>

      <form
        className="files-filterbar"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(`/collections/search?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <input
          className="dash-input files-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.plSearchPlaceholder}
          aria-label={t.plSearch}
        />
        <button className="pl-btn p" type="submit">
          {t.plSearch}
        </button>
      </form>

      {query && results.length === 0 && (
        <div className="dash-state-card">{t.plNoResults}</div>
      )}

      {results.length > 0 && (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>{t.plBatch}</th>
                <th>{t.plNameAr}</th>
                <th>{t.plNameEn}</th>
                <th>{t.plQid}</th>
                <th>{t.plCaseNumber}</th>
                <th>{t.plOutstanding}</th>
                <th>{t.plComplete}</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.id}>
                  <td dir="ltr">{r.batchCode}</td>
                  <td>
                    <a href={`/collections/customer/${r.id}`}>{r.nameAr ?? ''}</a>
                  </td>
                  <td dir="ltr">
                    <a href={`/collections/customer/${r.id}`}>{r.nameEn ?? ''}</a>
                  </td>
                  <td dir="ltr">{r.qid ?? ''}</td>
                  <td dir="ltr">{r.caseNumber ?? ''}</td>
                  <td dir="ltr">
                    {r.outstanding === null
                      ? ''
                      : r.outstanding.toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                  </td>
                  <td>
                    <span
                      className={`dash-chip${r.isComplete ? '' : ' dash-chip-gold'}`}
                    >
                      {r.isComplete ? t.plComplete : t.plIncomplete}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
