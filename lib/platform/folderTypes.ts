import 'server-only';
import { getSupabaseAdmin } from '../supabase';

/**
 * Folder types data-access layer.
 *
 * `folder_type` used to be a hardcoded 'case' | 'contract' enum; it is now
 * DATA in the `folder_types` table (see migration #14), so admins/managers can
 * add new types. Every type reuses one of the two EXISTING field layouts —
 * there are no new layouts, just more names for the two that already exist:
 *   • 'case'     → client + opponent (title renders client / vs / opponent)
 *   • 'contract' → client only (opponent forced null, no "vs" line)
 *
 * GLOBAL, not per-company: one shared list, same as the two built-ins were
 * before this existed.
 */

export type FolderTypeLayout = 'case' | 'contract';

export interface FolderTypeRecord {
  id: string;
  key: string;
  labelEn: string;
  labelAr: string;
  layout: FolderTypeLayout;
  isBuiltin: boolean;
}

interface FolderTypeRow {
  id: string;
  key: string;
  label_en: string;
  label_ar: string;
  layout: string;
  is_builtin: boolean;
}

function mapRow(row: FolderTypeRow): FolderTypeRecord {
  return {
    id: row.id,
    key: row.key,
    labelEn: row.label_en,
    labelAr: row.label_ar,
    layout: row.layout === 'contract' ? 'contract' : 'case',
    isBuiltin: row.is_builtin,
  };
}

/** Every folder type (built-in + custom), oldest first. */
export async function listFolderTypes(): Promise<FolderTypeRecord[]> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('folder_types')
    .select('id, key, label_en, label_ar, layout, is_builtin')
    .order('created_at', { ascending: true });
  if (res.error) throw new Error(res.error.message);
  return ((res.data as FolderTypeRow[] | null) ?? []).map(mapRow);
}

/** One folder type by key, or null if it does not exist. */
export async function getFolderTypeByKey(
  key: string
): Promise<FolderTypeRecord | null> {
  const supabase = getSupabaseAdmin();
  const res = await supabase
    .from('folder_types')
    .select('id, key, label_en, label_ar, layout, is_builtin')
    .eq('key', key)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  const row = res.data as FolderTypeRow | null;
  return row ? mapRow(row) : null;
}

/**
 * A key → layout lookup for resolving many files' folder types at once
 * (the files list/detail views need each file's layout, not its full record).
 */
export async function folderTypeLayoutsByKey(): Promise<
  Map<string, FolderTypeLayout>
> {
  const types = await listFolderTypes();
  return new Map(types.map((f) => [f.key, f.layout]));
}

function slugify(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'type';
}

/**
 * Create a new folder type. Authorization (admin or manager, ANY company,
 * since the list is global) is enforced by the caller. The key is slugified
 * from the English label and de-duplicated with a numeric suffix if needed.
 */
export async function createFolderType(input: {
  labelEn: string;
  labelAr: string;
  layout: FolderTypeLayout;
  createdBy: string;
}): Promise<FolderTypeRecord> {
  const supabase = getSupabaseAdmin();
  const base = slugify(input.labelEn);

  let key = base;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const existing = await getFolderTypeByKey(key);
    if (!existing) break;
    key = `${base}-${attempt + 2}`;
  }

  const res = await supabase
    .from('folder_types')
    .insert({
      key,
      label_en: input.labelEn,
      label_ar: input.labelAr,
      layout: input.layout,
      is_builtin: false,
      created_by: input.createdBy,
    })
    .select('id, key, label_en, label_ar, layout, is_builtin')
    .single();
  if (res.error) throw new Error(res.error.message);
  return mapRow(res.data as FolderTypeRow);
}
