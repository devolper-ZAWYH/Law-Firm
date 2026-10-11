'use client';

import { useEffect } from 'react';
import { STRINGS, type Lang } from '@/lib/i18n';
import { RELATED_WEBSITES } from '@/lib/relatedWebsites';

/**
 * RELATED WEBSITES — the firm's other sites, as a card of direct links.
 *
 * REPLACES the single "AlBaker AI" item that used to sit at the bottom of every
 * sidebar and jump straight out of the portal. One hard-coded destination could
 * not grow: the firm has more than one site, and the only way to reach the
 * others was to know the address. A card holds as many as there are, says what
 * each one IS before you leave for it, and keeps one nav row instead of a
 * growing stack of outbound links competing with the portal's own screens.
 *
 * The links are plain anchors to absolute URLs, each opening a new tab, so the
 * portal is never navigated away from and a middle-click behaves as expected.
 * `noreferrer` as well as `noopener`: these are separate products and have no
 * need to be handed this app's URL.
 */
export default function RelatedWebsitesModal({
  lang,
  onClose,
}: {
  lang: Lang;
  onClose: () => void;
}) {
  const t = STRINGS[lang];
  const ar = lang === 'ar';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="dash-modal-scrim"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t.navRelatedWebsites}
      dir={ar ? 'rtl' : 'ltr'}
    >
      <div className="dash-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dash-modal-head">
          <div>
            <h2 className="dash-title" style={{ margin: 0, fontSize: 18 }}>
              {t.navRelatedWebsites}
            </h2>
            <p className="dash-hint" style={{ margin: '4px 0 0' }}>
              {t.relatedWebsitesHint}
            </p>
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

        <ul className="site-list">
          {RELATED_WEBSITES.map((site) => (
            <li key={site.key}>
              <a
                className="site-link"
                href={site.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="site-link-main">
                  <span className="site-link-label" dir="auto">
                    {ar ? site.labelAr : site.labelEn}
                  </span>
                  {/* Optional — an entry with no description renders the label
                      straight above its address rather than an empty line. */}
                  {(ar ? site.descriptionAr : site.descriptionEn) && (
                    <span className="site-link-desc">
                      {ar ? site.descriptionAr : site.descriptionEn}
                    </span>
                  )}
                  {/* The address itself, always LTR: a URL reversed by an RTL
                      paragraph is unreadable and, worse, looks like a different
                      domain than the one it points at. */}
                  <span className="site-link-url" dir="ltr">
                    {site.href.replace(/^https?:\/\//, '')}
                  </span>
                </span>
                <span className="site-link-go" aria-hidden="true">
                  ↗
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
