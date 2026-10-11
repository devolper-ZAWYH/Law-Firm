import { describe, expect, it } from 'vitest';
import { parseDriveFolderId } from '@/lib/platform/drive';

/**
 * Every string below except the invented ones was taken from the LIVE database:
 * of 41 folders, 17 hold a real Drive folder URL, 9 are empty, and 15 hold text
 * that is not a link at all — the field has been used as a free-text note.
 *
 * That third case is why the parser reports it separately instead of folding it
 * into "no link": the two need different words in the UI and different fixes by
 * a person.
 */

describe('parseDriveFolderId — real link shapes', () => {
  it('reads a plain folder URL', () => {
    expect(
      parseDriveFolderId('https://drive.google.com/drive/folders/1AbC_dEF-123')
    ).toEqual({ kind: 'folder', folderId: '1AbC_dEF-123' });
  });

  it('reads one with ?usp=drive_link', () => {
    expect(
      parseDriveFolderId(
        'https://drive.google.com/drive/folders/1AbC_dEF-123?usp=drive_link'
      )
    ).toEqual({ kind: 'folder', folderId: '1AbC_dEF-123' });
  });

  it('reads one with ?usp=sharing', () => {
    expect(
      parseDriveFolderId(
        'https://drive.google.com/drive/folders/1AbC_dEF-123?usp=sharing'
      )
    ).toEqual({ kind: 'folder', folderId: '1AbC_dEF-123' });
  });

  it('reads a multi-account /u/N/ URL', () => {
    // This shape appears in the live data and is easy to miss: the account
    // index sits between /drive/ and /folders/.
    expect(
      parseDriveFolderId('https://drive.google.com/drive/u/4/folders/1AbC_dEF-123')
    ).toEqual({ kind: 'folder', folderId: '1AbC_dEF-123' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(
      parseDriveFolderId('  https://drive.google.com/drive/folders/1AbC_dEF-123  ')
    ).toEqual({ kind: 'folder', folderId: '1AbC_dEF-123' });
  });
});

describe('parseDriveFolderId — nothing linked', () => {
  it.each([null, undefined, '', '   '])('treats %p as no link', (v) => {
    expect(parseDriveFolderId(v as string | null)).toEqual({ kind: 'none' });
  });
});

describe('parseDriveFolderId — text that is not a Drive folder link', () => {
  it.each([
    'www.albaker.qa',
    'albaker.qa',
    'not now',
    'تم فرز الملفات وتحويلها الى ست ملفات فالعميل النشط',
  ])('flags %p rather than calling it "no link"', (v) => {
    expect(parseDriveFolderId(v)).toEqual({ kind: 'not_a_drive_link', raw: v });
  });

  it('does not accept a single-FILE Drive link as a folder', () => {
    // Listing needs a folder id; a file link would produce an empty listing
    // that looks like an empty folder rather than a mis-set field.
    expect(
      parseDriveFolderId('https://drive.google.com/file/d/1AbC_dEF-123/view')
    ).toEqual({
      kind: 'not_a_drive_link',
      raw: 'https://drive.google.com/file/d/1AbC_dEF-123/view',
    });
  });

  it('does not accept a Google Docs link as a folder', () => {
    const raw = 'https://docs.google.com/document/d/1AbC_dEF-123/edit';
    expect(parseDriveFolderId(raw)).toEqual({ kind: 'not_a_drive_link', raw });
  });
});
