// Lightweight loading skeleton shown during dashboard navigation (loading.tsx).
// Pure markup (no client JS) — reuses the shell layout classes for a smooth,
// no-layout-shift transition into the real page.
export default function DashboardSkeleton() {
  return (
    <div className="dash" aria-busy="true" aria-label="Loading">
      <aside className="dash-sidebar" aria-hidden="true">
        <div className="dash-brand">
          <span className="skel skel-logo" />
        </div>
        <div className="dash-nav-wrap">
          <span className="skel skel-eyebrow" />
          <span className="skel skel-nav" />
          <span className="skel skel-nav" />
        </div>
      </aside>
      <div className="dash-main">
        <div className="dash-topbar">
          <span className="skel skel-topbar" />
        </div>
        <div className="dash-content">
          <span className="skel skel-title" />
          <span className="skel skel-sub" />
          <span className="skel skel-card" />
        </div>
      </div>
    </div>
  );
}
