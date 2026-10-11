import type { NextRequest } from 'next/server';
import type { Membership, PlatformUser } from '@/lib/platform/auth';

/** Stable ids so a cross-company assertion reads unambiguously. */
export const COMPANY_A = '11111111-1111-4111-8111-111111111111';
export const COMPANY_B = '22222222-2222-4222-8222-222222222222';

export const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const MANAGER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const EMPLOYEE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const OTHER_EMPLOYEE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function membership(companyId: string, role: 'manager' | 'employee'): Membership {
  return {
    companyId,
    companyNameEn: 'Ali AlBaker Law Firm',
    companyNameAr: 'مكتب علي الباكر للمحاماة',
    role,
  };
}

/**
 * Build a resolved PlatformUser. Only `isAdmin` + `memberships` drive the
 * authorization predicates exercised here (canAdmin / roleInCompany /
 * isManagerOfCompany), so `companies` is derived from the memberships.
 */
export function makePlatformUser(opts: {
  userId: string;
  isAdmin?: boolean;
  memberships?: Array<{ companyId: string; role: 'manager' | 'employee' }>;
}): PlatformUser {
  const memberships = (opts.memberships ?? []).map((m) =>
    membership(m.companyId, m.role)
  );
  return {
    userId: opts.userId,
    username: `${opts.userId}@albaker.io`,
    fullNameEn: 'Test Person',
    fullNameAr: 'شخص تجريبي',
    isAdmin: opts.isAdmin === true,
    memberships,
    companies: memberships.map((m) => ({
      id: m.companyId,
      nameEn: m.companyNameEn,
      nameAr: m.companyNameAr,
      role: opts.isAdmin ? ('admin' as const) : m.role,
      isManager: m.role === 'manager',
      hasFilePermission: false,
      hasAttendancePermission: false,
      hasCrmPermission: false,
      hasCollectionsAccess: false,
    })),
  };
}

/** A global admin holding a manager membership too (the "Yousef" shape). */
export const adminUser = () =>
  makePlatformUser({
    userId: ADMIN_ID,
    isAdmin: true,
    memberships: [{ companyId: COMPANY_A, role: 'manager' }],
  });

/** A manager of COMPANY_A with no global admin flag. */
export const managerUser = () =>
  makePlatformUser({
    userId: MANAGER_ID,
    memberships: [{ companyId: COMPANY_A, role: 'manager' }],
  });

/** A plain employee of COMPANY_A — the lowest privilege that exists. */
export const employeeUser = () =>
  makePlatformUser({
    userId: EMPLOYEE_ID,
    memberships: [{ companyId: COMPANY_A, role: 'employee' }],
  });

/** Someone with no relationship to COMPANY_A at all. */
export const outsiderUser = () =>
  makePlatformUser({
    userId: OTHER_EMPLOYEE_ID,
    memberships: [{ companyId: COMPANY_B, role: 'manager' }],
  });

/**
 * The handlers under test only ever call `req.json()`, so a literal stub is
 * both sufficient and clearer than constructing a real NextRequest.
 */
export function jsonRequest(body: unknown): NextRequest {
  return {
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  } as unknown as NextRequest;
}

/** The GET handlers under test ignore their request argument entirely. */
export const unusedRequest = undefined as unknown as NextRequest;
