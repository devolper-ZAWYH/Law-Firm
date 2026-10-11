import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IDENTITY_FIELDS,
  IDENTITY_FIELD_NAMES,
  isIdentityField,
  changedIdentityFields,
} from '@/lib/platform/paylaterIdentity';

describe('which fields may be copied between a person’s files', () => {
  it('is the customer-details section, and nothing that carries money', () => {
    expect(IDENTITY_FIELD_NAMES.sort()).toEqual(
      [
        'email', 'gender', 'mobile', 'nameAr', 'nameEn',
        'nationality', 'paylaterRegDate', 'qid', 'qidName',
      ].sort()
    );
    // The debt is per file. If any of these ever appear here, one file's claim
    // could be copied onto another's, which is the whole thing being avoided.
    for (const forbidden of [
      'debtTotal', 'outstanding', 'instalmentCount', 'dpd', 'orders',
      'noticePlanned', 'caseRegDate', 'caseNumber', 'stage', 'bucket',
    ]) {
      expect(isIdentityField(forbidden)).toBe(false);
    }
  });

  it('reports only fields that actually changed', () => {
    const before = { nameAr: 'سليمان بابكر', mobile: '97466518855', email: null };
    expect(changedIdentityFields(before, { ...before })).toEqual([]);

    // Whitespace and null-vs-empty are the same value, not an edit — otherwise
    // the dialog fills with fields nobody touched and stops being read.
    expect(changedIdentityFields(before, { ...before, mobile: ' 97466518855 ' })).toEqual([]);
    expect(changedIdentityFields(before, { ...before, email: '' })).toEqual([]);

    expect(changedIdentityFields(before, { ...before, nameAr: 'سليمان خوجلي بابكر' })).toEqual([
      'nameAr',
    ]);
  });

  it('is enforced on the server, not just offered by the form', () => {
    // The form asks the question; the route decides. A request naming an
    // arbitrary column would otherwise be an edit primitive for the table.
    const route = readFileSync(
      join(process.cwd(), 'app/api/paylater/customers/route.ts'),
      'utf8'
    );
    expect(route).toContain('isIdentityField');
    expect(route).toContain('IDENTITY_FIELDS[f]');
    // and the targets are re-checked to be this company's files with this QID
    expect(route).toContain(".eq('company_id', ctx.companyId)");
    expect(route).toContain(".eq('qid', priorQid)");
  });

  it('a duplicate QID refuses a NEW file only, never an edit', () => {
    // The rule lived in two places and they disagreed: the form allowed an
    // existing file to be saved, the route answered 409, and the client showed
    // no error — so the edit vanished silently. Both halves are asserted here.
    const route = readFileSync(
      join(process.cwd(), 'app/api/paylater/customers/route.ts'),
      'utf8'
    );
    expect(route).toContain('const existing = id ? null : await findByQid(');

    const form = readFileSync(
      join(process.cwd(), 'components/collections/CustomerForm.tsx'),
      'utf8'
    );
    // The refusal is always reported, not only when it is not a duplicate.
    expect(form).not.toContain("if (data.duplicate) setDuplicate(data.duplicate);\n        else setError(");
    expect(form).toContain("setError(data.error ?? 'Could not save.');");
  });

  it('stays client-safe — the form imports it', () => {
    const mod = readFileSync(
      join(process.cwd(), 'lib/platform/paylaterIdentity.ts'),
      'utf8'
    );
    expect(mod).not.toContain("'server-only'");
  });
});
