'use client';

// Friendly, graceful error boundary UI for the dashboard routes (error.tsx).
// Rendered outside the shell/i18n context, so text is bilingual inline.
export default function DashboardErrorState({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="dash">
      <div className="dash-main dash-main-full">
        <div className="dash-content">
          <div className="dash-card dash-state-card">
            <h1 className="dash-title dash-title-sm">
              Something went wrong / حدث خطأ ما
            </h1>
            <p className="dash-subtitle">
              We couldn’t load this page. Please try again. / تعذّر تحميل هذه
              الصفحة. حاول مرة أخرى.
            </p>
            <button type="button" className="dash-btn-gold" onClick={() => reset()}>
              Retry / إعادة المحاولة
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
