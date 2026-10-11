'use client';

import DashboardErrorState from '@/components/DashboardErrorState';

export default function Error(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <DashboardErrorState {...props} />;
}
