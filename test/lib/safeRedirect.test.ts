import { describe, expect, it } from 'vitest';
import { safeNextPath } from '@/lib/safeRedirect';

/**
 * P2-4 regression suite — the `?next=` guard on the login page accepted any
 * string starting with '/', which includes protocol-relative URLs.
 */

describe('safeNextPath', () => {
  it('accepts an ordinary in-app path', () => {
    expect(safeNextPath('/admin/files')).toBe('/admin/files');
    expect(safeNextPath('/me?f=tasks')).toBe('/me?f=tasks');
  });

  it('rejects a protocol-relative URL', () => {
    // The exploit: '//evil.com' passes startsWith('/') but browsers resolve it
    // to https://evil.com.
    expect(safeNextPath('//evil.com')).toBeUndefined();
    expect(safeNextPath('//evil.com/login')).toBeUndefined();
  });

  it('rejects the backslash variant browsers normalise to //', () => {
    expect(safeNextPath('/\\evil.com')).toBeUndefined();
  });

  it('rejects an absolute URL to another origin', () => {
    expect(safeNextPath('https://evil.com')).toBeUndefined();
    expect(safeNextPath('javascript:alert(1)')).toBeUndefined();
  });

  it('rejects anything that is not a string', () => {
    expect(safeNextPath(undefined)).toBeUndefined();
    expect(safeNextPath(['/admin'])).toBeUndefined();
    expect(safeNextPath(42)).toBeUndefined();
  });

  it('rejects embedded control characters', () => {
    expect(safeNextPath('/admin\nSet-Cookie: x=1')).toBeUndefined();
    expect(safeNextPath('/admin\r\n')).toBeUndefined();
  });

  it('rejects the empty string so callers fall back to their default', () => {
    expect(safeNextPath('')).toBeUndefined();
  });
});
