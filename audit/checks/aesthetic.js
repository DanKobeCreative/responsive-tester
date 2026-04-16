// Aesthetic / design review via a local Ollama vision model. Takes its own
// viewport-sized JPEG (not the fullPage PNG — smaller = faster inference)
// and sends it to the model with a structured rubric. Parses the JSON
// response back as findings. Opt-in via --vision.
//
// Requires Ollama running at http://localhost:11434 with a vision model
// pulled. Default: llama3.2-vision. Override via --vision-model=<id>.
//
// Gracefully returns a single info finding if Ollama is unreachable so
// the audit still completes with the deterministic findings intact.

const DEFAULT_HOST = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.2-vision';
const CALL_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes — vision inference on a laptop is slow

const PROMPT = `You are reviewing a screenshot of a website for aesthetic issues. Be STRICT about evidence and skeptical of your own impressions.

## Rules

1. **No hallucinations.** Only flag things you can directly see in the image. If you're unsure what a text element says, don't flag it — you might be misreading it.
2. **No guessing intent.** A large logo is usually intentional brand identity, not a typography issue. A stylised video is usually intentional, not "out of focus". Dark/moody photography is usually intentional.
3. **No duplicates.** Never flag the same element more than once.
4. **No generic padding.** Skip vague findings like "text might be too small for some users" — only flag concrete, specific, visible issues.
5. **Prefer silence.** If the viewport genuinely looks clean, return an empty findings array. A short honest report beats a padded one.

## What to flag

Only these, and only when visually obvious:
- **Overflow** — content clipped or running off the edge of the viewport
- **Misalignment** — elements that should be aligned (gridded) but aren't
- **Collision / overlap** — elements overlapping that shouldn't be
- **Cropping failure** — a hero image showing only half a person's head, a logo cut in two, etc.
- **Unreadable contrast** — text that is actually hard to read (white on very light, black on very dark)
- **Broken media** — missing image icon, alt text showing instead of image

## Response format

Respond ONLY with this JSON:

{
  "findings": [
    { "severity": "warning", "area": "overflow", "message": "Specific observation citing what you see" }
  ]
}

Maximum 3 findings total. Severity is "warning" (clear issue) or "info" (minor polish). No "error". No text outside the JSON. If in doubt, return { "findings": [] }.`;

function buildUserMessage(viewport) {
  return `Viewport: ${viewport.name} — ${viewport.w}×${viewport.h} (${viewport.type})\n\nReview this screenshot for aesthetic and layout issues per the rubric. Return JSON only.`;
}

async function callOllama({ host, model, imageBase64, viewport }) {
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      format: 'json',
      stream: false,
      options: { temperature: 0.2, num_ctx: 8192 },
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: buildUserMessage(viewport), images: [imageBase64] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama responded ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.message?.content ?? '';
}

function parseFindings(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.findings)) return [];
    return parsed.findings.filter((f) => f && typeof f.message === 'string');
  } catch {
    return [];
  }
}

export default async function check(page, viewport, ctx) {
  if (!ctx?.vision) return [];

  const host = ctx.vision.host || DEFAULT_HOST;
  const model = ctx.vision.model || DEFAULT_MODEL;

  // Take a viewport-only JPEG just for the vision model — much smaller than
  // the fullPage PNG the human report uses, so inference finishes in a
  // reasonable time. 70% quality is imperceptible at this scale.
  let imageBase64;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
    imageBase64 = buf.toString('base64');
  } catch (e) {
    return [{ check: 'aesthetic', severity: 'warning', message: `Vision screenshot failed: ${e.message}` }];
  }

  let raw;
  try {
    raw = await callOllama({ host, model, imageBase64, viewport });
  } catch (e) {
    const msg = e.cause?.code ? `${e.message} (${e.cause.code})` : e.message;
    if (/ECONNREFUSED/.test(msg)) {
      return [{ check: 'aesthetic', severity: 'info', message: `Ollama not reachable at ${host} — skipping vision pass. Run \`brew services start ollama\` and \`ollama pull ${model}\`.` }];
    }
    return [{ check: 'aesthetic', severity: 'warning', message: `Vision model call failed: ${msg}` }];
  }

  const items = parseFindings(raw);
  return items.map((f) => ({
    check: `aesthetic:${f.area || 'general'}`,
    severity: f.severity === 'info' ? 'info' : 'warning',
    message: f.message,
    meta: { area: f.area, model },
  }));
}
