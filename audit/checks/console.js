// Consumes the console + network error buffers captured by the runner
// during navigation. These are collected at a higher level (see run.js) so
// this check is just a formatter — it isn't page.evaluate-based.

export default async function check(page, viewport, ctx) {
  const findings = [];

  for (const entry of ctx?.consoleErrors ?? []) {
    findings.push({
      check: 'console',
      severity: entry.type === 'error' ? 'error' : 'warning',
      message: `[${entry.type}] ${entry.text}`,
      meta: { location: entry.location },
    });
  }

  for (const entry of ctx?.networkErrors ?? []) {
    findings.push({
      check: 'network',
      severity: 'error',
      message: `${entry.method} ${entry.url} — ${entry.failure}`,
      meta: entry,
    });
  }

  return findings;
}
