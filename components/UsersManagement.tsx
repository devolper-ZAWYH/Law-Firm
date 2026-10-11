'use client';

import dynamic from 'next/dynamic';
import { useDash } from './DashboardShell';
import UsersTable, { type UserRow } from './UsersTable';

// Code-split the interactive create-user form so it doesn't weigh down the
// initial users-list payload; it hydrates on the client with a light placeholder.
const CreateUserForm = dynamic(
  () => import('../app/admin/users/CreateUserForm'),
  {
    ssr: false,
    loading: () => <div className="dash-card dash-card-loading" aria-hidden="true" />,
  }
);

export default function UsersManagement({ users }: { users: UserRow[] }) {
  const { t } = useDash();

  return (
    <>
      <div className="dash-page-head">
        <div>
          <h1 className="dash-title">{t.userManagement}</h1>
          <p className="dash-subtitle">{t.userManagementSubtitle}</p>
        </div>
        <a className="dash-back" href="/admin">
          {/* A literal arrow does not mirror. "Back" points left in English and
              RIGHT in Arabic; .cal-nav-arrow flips it under RTL. Hidden from
              assistive tech — the link text already says where it goes. */}
          <span className="cal-nav-arrow" aria-hidden="true">
            ←
          </span>{' '}
          {t.backToOverview}
        </a>
      </div>

      <div className="dash-grid-2">
        <UsersTable users={users} />
        <CreateUserForm />
      </div>
    </>
  );
}
