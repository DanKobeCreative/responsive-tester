// axe-core accessibility pass. Uses @axe-core/playwright and reports each
// violation as one finding. Severity maps axe impact levels.

import { AxeBuilder } from '@axe-core/playwright';

const SEVERITY = { minor: 'info', moderate: 'warning', serious: 'error', critical: 'error' };

export default async function check(page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();

  return results.violations.flatMap((v) =>
    v.nodes.slice(0, 5).map((node) => ({
      check: `a11y:${v.id}`,
      severity: SEVERITY[v.impact] ?? 'warning',
      message: `${v.help} — ${node.failureSummary?.split('\n')[0] ?? v.description}`,
      selector: node.target.join(' > '),
      meta: { rule: v.id, helpUrl: v.helpUrl, impact: v.impact },
    }))
  );
}
