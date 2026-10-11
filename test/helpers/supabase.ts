import { vi } from 'vitest';

/**
 * A minimal stand-in for the PostgREST query builder returned by
 * `getSupabaseAdmin()`.
 *
 * Every filter/mutation method records itself and returns the builder, so the
 * real call chains in the route handlers work unchanged. A query settles either
 * via `.maybeSingle()` / `.single()` or by awaiting the builder directly (the
 * employees route does both) — the builder is therefore also a thenable.
 *
 * Tests supply a `resolve(query)` callback that decides what each query returns,
 * and can afterwards inspect `queries` to assert what the handler actually asked
 * the database to do.
 */

export interface ChainCall {
  method: string;
  args: unknown[];
}

export interface QueryRecord {
  table: string;
  calls: ChainCall[];
}

export interface QueryResult {
  data?: unknown;
  error?: unknown;
  count?: number;
}

/** True if this query invoked `method` (e.g. 'update', 'upsert'). */
export function used(q: QueryRecord, method: string): boolean {
  return q.calls.some((c) => c.method === method);
}

/** The first argument passed to `method` on this query, if it was called. */
export function argOf(q: QueryRecord, method: string): unknown {
  return q.calls.find((c) => c.method === method)?.args[0];
}

const CHAINABLE = [
  'select',
  'insert',
  'update',
  'upsert',
  'delete',
  'eq',
  'neq',
  'in',
  'or',
  'is',
  'gte',
  'lte',
  'order',
  'limit',
  'filter',
] as const;

export function makeSupabaseStub(resolve: (q: QueryRecord) => QueryResult) {
  const queries: QueryRecord[] = [];

  const client = {
    from(table: string) {
      const record: QueryRecord = { table, calls: [] };
      queries.push(record);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {};
      for (const method of CHAINABLE) {
        builder[method] = (...args: unknown[]) => {
          record.calls.push({ method, args });
          return builder;
        };
      }

      const settle = () =>
        Promise.resolve({ data: null, error: null, ...resolve(record) });

      builder.maybeSingle = (...args: unknown[]) => {
        record.calls.push({ method: 'maybeSingle', args });
        return settle();
      };
      builder.single = (...args: unknown[]) => {
        record.calls.push({ method: 'single', args });
        return settle();
      };
      // Awaiting the builder itself (e.g. `await supabase.from(x).update(y).eq(...)`).
      builder.then = (
        onFulfilled?: (v: QueryResult) => unknown,
        onRejected?: (e: unknown) => unknown
      ) => settle().then(onFulfilled, onRejected);

      return builder;
    },
  };

  return { client, queries, getSupabaseAdmin: vi.fn(() => client) };
}
