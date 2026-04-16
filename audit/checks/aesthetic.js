// Aesthetic / design review. Two backends:
//
//   --vision=ollama   — local Ollama + llama3.2-vision (free, ~30–45s/viewport,
//                       ~40% signal / ~60% noise). Default when --vision alone.
//   --vision=api      — Anthropic API + Claude Haiku 4.5 (pennies/run, fast,
//                       much better judgment). Requires ANTHROPIC_API_KEY env.
//
// Takes its own viewport-sized JPEG (smaller than the fullPage PNG the
// report uses) so inference stays snappy.

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3.2-vision';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const OLLAMA_TIMEOUT_MS = 5 * 60 * 1000;

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
- **Hierarchy / CTA** — no clear primary action; the main message fights with competing elements

## Response format

Respond ONLY with this JSON:

{
  "findings": [
    { "severity": "warning", "area": "overflow", "message": "Specific observation citing what you see" }
  ]
}

Maximum 3 findings total. Severity is "warning" (clear issue) or "info" (minor polish). No "error". No text outside the JSON. If in doubt, return { "findings": [] }.`;

function buildUserText(viewport) {
  return `Viewport: ${viewport.name} — ${viewport.w}×${viewport.h} (${viewport.type})\n\nReview this screenshot for aesthetic and layout issues per the rubric. Return JSON only.`;
}

// ── Ollama backend ──────────────────────────────────────────────────
async function callOllama({ host, model, imageBase64, viewport }) {
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      format: 'json',
      stream: false,
      options: { temperature: 0.2, num_ctx: 8192 },
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: buildUserText(viewport), images: [imageBase64] },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama responded ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.message?.content ?? '';
}

// ── Anthropic backend ───────────────────────────────────────────────
let _anthropic;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var is not set');
  _anthropic = new Anthropic({ apiKey });
  return _anthropic;
}

async function callAnthropic({ model, imageBase64, viewport }) {
  const client = getAnthropic();
  const message = await client.messages.create({
    model,
    max_tokens: 512,
    system: PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: buildUserText(viewport) },
        ],
      },
    ],
  });
  const block = message.content.find((b) => b.type === 'text');
  return block?.text ?? '';
}

// ── Output parsing ──────────────────────────────────────────────────
function parseFindings(raw) {
  if (!raw) return [];
  // Strip markdown code fences the model sometimes adds despite the system prompt.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.findings)) return [];
    return parsed.findings.filter((f) => f && typeof f.message === 'string');
  } catch {
    return [];
  }
}

export default async function check(page, viewport, ctx) {
  if (!ctx?.vision) return [];
  const backend = ctx.vision.backend || 'ollama';

  let imageBase64;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
    imageBase64 = buf.toString('base64');
  } catch (e) {
    return [{ check: 'aesthetic', severity: 'warning', message: `Vision screenshot failed: ${e.message}` }];
  }

  let raw;
  try {
    if (backend === 'api' || backend === 'anthropic') {
      const model = ctx.vision.model || DEFAULT_ANTHROPIC_MODEL;
      raw = await callAnthropic({ model, imageBase64, viewport });
    } else {
      const host = ctx.vision.host || DEFAULT_OLLAMA_HOST;
      const model = ctx.vision.model || DEFAULT_OLLAMA_MODEL;
      raw = await callOllama({ host, model, imageBase64, viewport });
    }
  } catch (e) {
    const msg = e.cause?.code ? `${e.message} (${e.cause.code})` : e.message;
    if (backend === 'ollama' && /ECONNREFUSED/.test(msg)) {
      return [{ check: 'aesthetic', severity: 'info', message: `Ollama not reachable at ${ctx.vision.host || DEFAULT_OLLAMA_HOST}. Start Ollama.app or run \`ollama serve\`.` }];
    }
    return [{ check: 'aesthetic', severity: 'warning', message: `Vision model call failed: ${msg}` }];
  }

  const items = parseFindings(raw);
  const modelUsed = ctx.vision.model || (backend === 'api' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OLLAMA_MODEL);
  return items.map((f) => ({
    check: `aesthetic:${f.area || 'general'}`,
    severity: f.severity === 'info' ? 'info' : 'warning',
    message: f.message,
    meta: { area: f.area, backend, model: modelUsed },
  }));
}
