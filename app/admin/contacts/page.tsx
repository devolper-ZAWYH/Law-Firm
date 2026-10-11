import { redirect } from 'next/navigation';
import DashboardShell from '@/components/DashboardShell';
import ContactsView from '@/components/ContactsView';
import {
  requirePlatformUser,
  canAdmin,
  landingForPlatformUser,
} from '@/lib/platform/auth';
import { companiesWithAnyCapability } from '@/lib/platform/capabilityGrants';

export const metadata = { title: 'Contacts — AlBaker Platform' };
export const dynamic = 'force-dynamic';

// Contacts (CRM). Reachable by an admin, by a MANAGER of any company (they can
// now add clients — see the contacts POST route), and by an employee granted
// 'company.contacts' (read the directory), 'company.contactsAdd' (add to it) or
// 'company.contactsEdit' (change an entry) in at least one company. Managers
// may now edit as well as add; DELETING a contact remains admin-only, and all
// of it is re-enforced by the API. Everyone else is redirected to their home.
export default async function ContactsPage() {
  const pu = await requirePlatformUser();
  if (!canAdmin(pu)) {
    const isManagerSomewhere = pu.companies.some(
      (c) => c.isManager || c.role === 'manager'
    );
    if (!isManagerSomewhere) {
      const granted = await companiesWithAnyCapability(pu.userId, [
        'company.contacts',
        'company.contactsAdd',
        'company.contactsEdit',
      ]);
      if (granted.size === 0) redirect(landingForPlatformUser(pu));
    }
  }

  const identity = {
    userId: pu.userId,
    username: pu.username,
    fullNameEn: pu.fullNameEn,
    fullNameAr: pu.fullNameAr,
    isAdmin: pu.isAdmin,
  };

  return (
    <DashboardShell identity={identity} companies={pu.companies} active="contacts">
      <ContactsView />
    </DashboardShell>
  );
}
