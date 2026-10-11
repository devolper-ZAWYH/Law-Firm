import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { missingIntakeParts } from '@/lib/platform/paylaterIntake';

describe('how many files need data', () => {
  it('is counted from the rule, never from the stored flag', () => {
    /*
      The flag is written at save time and every writer has to remember to
      recompute it. Two did not, so a folder counted three files needing data
      while the table inside it — which evaluates the rule per row — showed two.
      Counting from the data cannot drift from the table, because it IS what
      the table does.
    */
    const src = readFileSync(join(process.cwd(), 'lib/platform/paylater.ts'), 'utf8');
    const listBatches = src.slice(src.indexOf('export async function listBatches'));
    const body = listBatches.slice(0, listBatches.indexOf('export async function', 10));
    expect(body).toContain('missingIntakeParts(');
    // The QUERY must not ask for the flag — the prose above it may name it.
    expect(body).not.toContain("select('batch_id, is_complete')");
    expect(body).not.toContain('if (!c.is_complete)');
  });

  it('agrees with the table for the same customer', () => {
    // One customer, evaluated the way both places evaluate them.
    const complete = {
      gender: 'female',
      reportDate: '2026-08-05',
      paylaterRegDate: '2025-06-05',
      orderCount: 1,
    };
    expect(missingIntakeParts(complete)).toEqual([]);
    expect(missingIntakeParts({ ...complete, gender: null })).toEqual(['gender']);
    expect(missingIntakeParts({ ...complete, orderCount: 0 })).toEqual(['orders']);
  });

  it('the writers that fill a field re-decide the flag', () => {
    // Kept honest for the search screen's chip, which still reads it.
    for (const f of [
      'app/api/paylater/customers/route.ts',
      'app/api/paylater/import/route.ts',
    ]) {
      expect(readFileSync(join(process.cwd(), f), 'utf8')).toContain(
        'isCustomerCompleteFromParts'
      );
    }
  });
});

describe('the file number', () => {
  it('comes from the number on the ZIP folder', () => {
    // "001- 29900000001 SAMPLE CUSTOMER ONE" → 001. It is written on the
    // physical file and used in the Progress Report, so it is a fact rather
    // than something to derive from QID order.
    const modal = readFileSync(
      join(process.cwd(), 'components/collections/BulkReportsModal.tsx'),
      'utf8'
    );
    expect(modal).toContain('const fileNo = leaf.match(');

    const route = readFileSync(
      join(process.cwd(), 'app/api/paylater/bulk-reports/route.ts'),
      'utf8'
    );
    // Stored as the MANUAL number, and never over a number a person set.
    expect(route).toContain("patch.file_no_manual = fileNo.padStart(3, '0')");
    expect(route).toContain('if (fileNo && !cust.file_no_manual)');
  });

  it('reads only a leading number, so an unnumbered folder is left alone', () => {
    const leaf = (name: string) => name.match(/^\s*(\d{1,4})\b/)?.[1];
    expect(leaf('001- 29900000001 SAMPLE CUSTOMER ONE')).toBe('001');
    expect(leaf('  012 - 29900000002 SAMPLE CUSTOMER TWO')).toBe('012');
    expect(leaf('SAMPLE CUSTOMER ONE')).toBeUndefined();
    expect(leaf('QID29900000001')).toBeUndefined();
  });
});
