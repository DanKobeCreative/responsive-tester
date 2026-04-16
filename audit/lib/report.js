// Findings → Markdown audit report.

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

export function buildReport({ url, startedAt, finishedAt, viewports, viewportFindings, pageFindings }) {
  const lines = [];
  const totals = countSeverities([...Object.values(viewportFindings).flat(), ...pageFindings]);

  lines.push(`# Responsive audit`);
  lines.push('');
  lines.push(`- **URL:** ${url}`);
  lines.push(`- **Run:** ${startedAt} → ${finishedAt}`);
  lines.push(`- **Viewports:** ${viewports.map((v) => `${v.name} (${v.w}×${v.h})`).join(', ')}`);
  lines.push(`- **Totals:** ${totals.error} errors · ${totals.warning} warnings · ${totals.info} info`);
  lines.push('');

  if (pageFindings.length) {
    lines.push(`## Page-level`);
    lines.push(''); lines.push(...renderFindings(pageFindings)); lines.push('');
  }

  for (const v of viewports) {
    const findings = viewportFindings[v.id] ?? [];
    lines.push(`## ${v.name} — ${v.w}×${v.h} (${v.type})`);
    lines.push('');
    lines.push(`![screenshot](screenshots/${v.id}.png)`);
    lines.push('');
    if (!findings.length) {
      lines.push('_No findings._');
    } else {
      const vTotals = countSeverities(findings);
      lines.push(`${vTotals.error} errors · ${vTotals.warning} warnings · ${vTotals.info} info`);
      lines.push('');
      lines.push(...renderFindings(findings));
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderFindings(findings) {
  const byCheck = new Map();
  for (const f of [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, []);
    byCheck.get(f.check).push(f);
  }
  const lines = [];
  for (const [check, list] of byCheck) {
    lines.push(`### \`${check}\` (${list.length})`);
    lines.push('');
    for (const f of list.slice(0, 25)) {
      const badge = f.severity === 'error' ? '❗' : f.severity === 'warning' ? '⚠️' : 'ℹ️';
      const selector = f.selector ? `  \n  \`${f.selector}\`` : '';
      lines.push(`- ${badge} ${f.message}${selector}`);
    }
    if (list.length > 25) lines.push(`- _(+${list.length - 25} more)_`);
    lines.push('');
  }
  return lines;
}

function countSeverities(findings) {
  return findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, { error: 0, warning: 0, info: 0 });
}
