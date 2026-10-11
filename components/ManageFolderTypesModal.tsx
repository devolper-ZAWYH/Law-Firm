'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDash } from './DashboardShell';
import { invalidateFolderTypes } from './folderTypesCache';

export interface ClientFolderTypeRecord {
  id: string;
  key: string;
  labelEn: string;
  labelAr: string;
  layout: 'case' | 'contract';
  isBuiltin: boolean;
}

/**
 * "Manage folder types" — admin/manager only. Lists every folder type
 * (built-ins first, non-deletable) and lets the caller add a new one: a
 * label in each language, and which of the two EXISTING field layouts it
 * reuses (client + opponent, or client only). No edit/delete of custom types
 * in this pass — add-only, matching the folders design.
 */
export default function ManageFolderTypesModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const { t, lang, activeCompany } = useDash();

  const [types, setTypes] = useState<ClientFolderTypeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [labelEn, setLabelEn] = useState('');
  const [labelAr, setLabelAr] = useState('');
  const [layout, setLayout] = useState<'case' | 'contract'>('case');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // This screen deliberately does NOT read the shared cache: it is where types
  // are added, so it must always show the live list. It INVALIDATES the cache
  // after a successful add (below) so every other screen picks the new one up.
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch('/api/folder-types', { cache: 'no-store' });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        folderTypes?: ClientFolderTypeRecord[];
      };
      if (!res.ok || !data.ok || !Array.isArray(data.folderTypes)) {
        setLoadError(true);
        setTypes([]);
      } else {
        setTypes(data.folderTypes);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const canSubmit =
    !saving && labelEn.trim().length > 0 && labelAr.trim().length > 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/folder-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label_en: labelEn.trim(),
          label_ar: labelAr.trim(),
          layout,
          // Folder types themselves are company-agnostic, but the PERMISSION
          // to add one is per-company — so the server needs to know which
          // company this is being done in to resolve the approval gate.
          company_id: activeCompany?.id ?? null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        folderType?: ClientFolderTypeRecord;
      };
      if (!res.ok || !data.ok || !data.folderType) {
        setError(data.error || t.couldNotSaveFolderType);
        setSaving(false);
        return;
      }
      setTypes((prev) => [...prev, data.folderType as ClientFolderTypeRecord]);
      // The new type must appear in the other screens' dropdowns without a
      // page reload, so drop the shared cache rather than let it go stale.
      invalidateFolderTypes();
      setLabelEn('');
      setLabelAr('');
      setLayout('case');
      setSaving(false);
    } catch {
      setError(t.networkError);
      setSaving(false);
    }
  }

  return (
    <div
      className="dash-modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={t.folderTypesTitle}
      onClick={onClose}
    >
      <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dash-modal-head">
          <div className="dash-section-header" style={{ margin: 0 }}>
            <span className="dash-sq dash-sq-gold" aria-hidden="true" />
            {t.folderTypesTitle}
          </div>
          <button
            type="button"
            className="dash-modal-close"
            aria-label={t.close}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <p className="dash-hint" style={{ margin: '0 0 12px' }}>
          {t.folderTypesSubtitle}
        </p>

        {loading ? (
          <p className="dash-subtitle">…</p>
        ) : loadError ? (
          <div className="dash-alert dash-alert-error" role="alert">
            {t.couldNotLoadFolderTypes}
          </div>
        ) : (
          <ul
            style={{ listStyle: 'none', margin: 0, padding: 0, marginBottom: 16 }}
          >
            {types.map((ft) => (
              <li
                key={ft.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 0',
                }}
              >
                <span>{lang === 'ar' ? ft.labelAr : ft.labelEn}</span>
                {ft.isBuiltin && (
                  <span className="dash-hint" style={{ margin: 0 }}>
                    ({t.builtinTag})
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {error && (
          <div className="dash-alert dash-alert-error" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} noValidate>
          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="ft-label-en">
              {t.folderTypeLabelEn}
            </label>
            <input
              id="ft-label-en"
              className="dash-input"
              dir="ltr"
              value={labelEn}
              onChange={(e) => setLabelEn(e.target.value)}
            />
          </div>

          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="ft-label-ar">
              {t.folderTypeLabelAr}
            </label>
            <input
              id="ft-label-ar"
              className="dash-input"
              dir="rtl"
              value={labelAr}
              onChange={(e) => setLabelAr(e.target.value)}
            />
          </div>

          <div className="dash-field">
            <label className="dash-eyebrow" htmlFor="ft-layout">
              {t.folderTypeLayoutField}
            </label>
            <select
              id="ft-layout"
              className="dash-input"
              value={layout}
              onChange={(e) =>
                setLayout(e.target.value === 'contract' ? 'contract' : 'case')
              }
            >
              <option value="case">{t.layoutCaseOption}</option>
              <option value="contract">{t.layoutContractOption}</option>
            </select>
          </div>

          <div className="dash-modal-actions">
            <button
              type="button"
              className="dash-btn-ghost"
              onClick={onClose}
              disabled={saving}
            >
              {t.cancel}
            </button>
            <button
              type="submit"
              className="dash-btn-gold"
              disabled={!canSubmit}
            >
              {saving ? t.saving : t.addFolderType}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
