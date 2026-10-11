import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APPROVAL_ACTION_BY_CAPABILITY } from '@/lib/platform/capabilities';

/**
 * A STRUCTURAL guard, not a behavioural one.
 *
 * APPROVAL_ACTION_BY_CAPABILITY is what the employee edit card reads to decide
 * which permissions get a "requires approval" toggle. If a key is listed there
 * but its route never calls gateAction, the toggle renders, the manager checks
 * it, and the action goes on happening immediately — a switch that silently
 * does nothing, which is the one failure this whole design is meant to make
 * impossible. That gap is invisible to unit tests of either half, so it is
 * checked here against the actual route sources.
 *
 * It caught exactly that: three capabilities were listed with executors written
 * but their routes not yet wired.
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const ROUTE_SOURCE = sourceFiles(join(process.cwd(), 'app'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

describe('every gateable capability is actually wired into a route', () => {
  const keys = Object.keys(APPROVAL_ACTION_BY_CAPABILITY);

  /**
   * A key counts as wired when the route gates on IT or on any key sharing its
   * action. Routes enforce the COARSE key — 'files.edit' — while its children
   * ('files.edit.client' and friends) satisfy that key through expansion, so
   * the child is genuinely covered without appearing in the route source.
   */
  const wiredActions = new Set(
    keys
      .filter((k) => ROUTE_SOURCE.includes(`capabilityKey: '${k}'`))
      .map((k) => APPROVAL_ACTION_BY_CAPABILITY[k])
  );

  it.each(keys)('%s reaches gateAction through its action', (key) => {
    expect(
      wiredActions.has(APPROVAL_ACTION_BY_CAPABILITY[key]),
      `'${key}' is offered as an approval toggle but no route gates on its ` +
        `action '${APPROVAL_ACTION_BY_CAPABILITY[key]}' — either wire ` +
        `gateAction into its route, or remove it from ` +
        `APPROVAL_ACTION_BY_CAPABILITY so the UI stops offering the switch.`
    ).toBe(true);
  });

  it('has at least the three capabilities this work was asked for', () => {
    expect(keys).toEqual(
      expect.arrayContaining(['tasks.delete', 'files.create', 'company.contactsAdd'])
    );
  });
});
