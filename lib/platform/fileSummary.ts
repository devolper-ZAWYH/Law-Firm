import 'server-only';
import { getSupabaseAdmin } from '../supabase';
import { fetchUsersByIds } from './access';

/**
 * THE FOLDER'S SUMMARY — one standing description per folder.
 *
 * Distinct from comments on purpose: comments are a log of moments, a summary
 * is the current answer to "what is this matter". There is exactly one, it is
 * written once, and it is edited from then on.
 *
 * DEPLOY SAFETY: reads degrade to null and writes to a no-op if the migration
 * has not been applied yet (Postgres 42P01 / 42703), matching the convention in
 * lib/platform/notifications.ts.
 */

export interface FileSummary {
  fileId: string;
  body: string;
  createdByName: string | null;
  createdAt: string;
  updatedByName: string | null;
  updatedAt: string;
}

interface SummaryRow {
  file_id: string;
  body: string;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === '42P01' || error?.code === '42703';
}

const COLUMNS = 'file_id, body, created_by, created_at, updated_by, updated_at';

/** Resolve the two author ids into display names in one lookup. */
async function toSummary(row: SummaryRow, lang: 'en' | 'ar'): Promise<FileSummary> {
  const ids = [row.created_by, row.updated_by].filter(
    (x): x is string => typeof x === 'string'
  );
  const byId = ids.length > 0 ? await fetchUsersByIds(ids) : new Map();
  const nameOf = (id: string | null) => {
    if (!id) return null;
    const p = byId.get(id);
    if (!p) return null;
    return (
      (lang === 'ar' ? p.fullNameAr : p.fullNameEn) ||
      p.fullNameEn ||
      p.fullNameAr ||
      p.username
    );
  };
  return {
    fileId: row.file_id,
    body: row.body,
    createdByName: nameOf(row.created_by),
    createdAt: row.created_at,
    updatedByName: nameOf(row.updated_by),
    updatedAt: row.updated_at,
  };
}

/** The folder's summary, or null when none has been written yet. */
export async function getFileSummary(
  fileId: string,
  lang: 'en' | 'ar' = 'en'
): Promise<FileSummary | null> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('file_summaries')
    .select(COLUMNS)
    .eq('file_id', fileId)
    .maybeSingle();
  if (res.error) {
    if (isMissingRelation(res.error as { code?: string })) return null;
    throw new Error(res.error.message);
  }
  const row = res.data as SummaryRow | null;
  return row ? toSummary(row, lang) : null;
}

export type SaveSummaryResult =
  | { ok: true; summary: FileSummary }
  | { ok: false; code: 'bad_input' };

/**
 * Write the folder's summary — creating it the first time, replacing the body
 * thereafter. One row per file is enforced by the unique index, so this is an
 * upsert on file_id rather than a create/update branch in the caller.
 */
export async function saveFileSummary(input: {
  fileId: string;
  body: string;
  actorId: string;
  lang?: 'en' | 'ar';
}): Promise<SaveSummaryResult> {
  const body = input.body.trim();
  if (!body) return { ok: false, code: 'bad_input' };

  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  const existing = await supabase
    .from('file_summaries')
    .select('file_id')
    .eq('file_id', input.fileId)
    .maybeSingle();
  if (existing.error && !isMissingRelation(existing.error as { code?: string })) {
    throw new Error(existing.error.message);
  }
  const isFirstWrite = !existing.data;

  const res = await supabase
    .from('file_summaries')
    .upsert(
      {
        file_id: input.fileId,
        body,
        // created_by/created_at belong to whoever wrote it FIRST and are not
        // touched by a later edit.
        ...(isFirstWrite
          ? { created_by: input.actorId, created_at: nowIso }
          : {}),
        updated_by: input.actorId,
        updated_at: nowIso,
      },
      { onConflict: 'file_id' }
    )
    .select(COLUMNS)
    .single();
  if (res.error) throw new Error(res.error.message);
  return { ok: true, summary: await toSummary(res.data as SummaryRow, input.lang ?? 'en') };
}
