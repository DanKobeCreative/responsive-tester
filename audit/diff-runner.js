#!/usr/bin/env node
// Visual diff runner. Spawned by the desktop app's Rust side
// (src-tauri/src/qa.rs); reads a config from stdin describing one
// baseline and one current screenshot directory; pairs them by
// {engine}/{viewport-id}.png and runs pixelmatch on each pair, writing
// a magenta-on-transparent diff PNG and emitting NDJSON results to
// stdout for Tauri to stream to the frontend.
//
// Mask regions blank out chosen rectangles in BOTH images before the
// diff so dynamic content (date headers, carousels) doesn't show as a
// false-positive regression. Coordinates are stored as percentages of
// the source image dimensions so a mask drawn against one screenshot
// still applies after layout changes.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stdin } from 'node:process';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function readStdinJson() {
  let raw = '';
  for await (const chunk of stdin) raw += chunk;
  if (!raw.trim()) throw new Error('No config received on stdin.');
  return JSON.parse(raw);
}

async function loadPng(filePath) {
  const data = await fs.readFile(filePath);
  return PNG.sync.read(data);
}

function blankRegion(png, x, y, w, h) {
  // Replace the rectangle with solid-grey pixels in both R/G/B/A so
  // pixelmatch compares "identical grey" → 0 mismatch in masked area.
  const right = Math.min(png.width, x + w);
  const bottom = Math.min(png.height, y + h);
  for (let py = y; py < bottom; py++) {
    for (let px = x; px < right; px++) {
      const idx = (png.width * py + px) << 2;
      png.data[idx] = 128;
      png.data[idx + 1] = 128;
      png.data[idx + 2] = 128;
      png.data[idx + 3] = 255;
    }
  }
}

function applyMasks(png, masks, sourceWidth, sourceHeight) {
  if (!masks || !masks.length) return 0;
  let applied = 0;
  for (const m of masks) {
    // Coords stored as percentages 0..1 of the SOURCE dimensions
    // (the dimensions the mask was originally drawn against).
    // Re-project to current png dimensions.
    const x = Math.round((m.xPct ?? 0) * png.width);
    const y = Math.round((m.yPct ?? 0) * png.height);
    const w = Math.round((m.widthPct ?? 0) * png.width);
    const h = Math.round((m.heightPct ?? 0) * png.height);
    if (w <= 0 || h <= 0) continue;
    blankRegion(png, x, y, w, h);
    applied++;
  }
  return applied;
}

// pixelmatch needs both images to be exactly the same dimensions. If
// they differ in height, pad the shorter one with transparent pixels.
function padToHeight(png, targetHeight) {
  if (png.height >= targetHeight) return png;
  const padded = new PNG({ width: png.width, height: targetHeight });
  png.data.copy(padded.data, 0, 0, png.data.length);
  // Remaining bytes (the new bottom) are zero-initialised — fully
  // transparent black, which pixelmatch's antialias handling treats as
  // background and won't false-positive against.
  return padded;
}

function masksFor(masks, viewportId, engine) {
  if (!masks) return [];
  return masks.filter((m) => {
    const matchesViewport = m.viewportId === '*' || m.viewportId === viewportId;
    const matchesEngine = !m.engine || m.engine === '*' || m.engine === engine;
    return matchesViewport && matchesEngine;
  }).flatMap((m) => m.regions || []);
}

async function runComparison(engine, viewport, basePath, currPath, diffOut, masks, threshold) {
  let baseline, current;
  try {
    baseline = await loadPng(basePath);
    current = await loadPng(currPath);
  } catch (e) {
    emit({ type: 'diff-error', engine, viewport, message: `Could not load images: ${e.message}` });
    return;
  }

  const heightDelta = current.height - baseline.height;
  if (baseline.width !== current.width) {
    emit({
      type: 'diff-error',
      engine,
      viewport,
      message: `Width mismatch: baseline ${baseline.width}px vs current ${current.width}px`,
    });
    return;
  }

  if (heightDelta !== 0) {
    const targetHeight = Math.max(baseline.height, current.height);
    baseline = padToHeight(baseline, targetHeight);
    current = padToHeight(current, targetHeight);
    emit({
      type: 'diff-warning',
      engine,
      viewport,
      message: `Height mismatch — padded for comparison`,
      heightDelta,
    });
  }

  const regions = masksFor(masks, viewport, engine);
  const baseMasked = applyMasks(baseline, regions, baseline.width, baseline.height);
  const currMasked = applyMasks(current, regions, current.width, current.height);

  const { width, height } = baseline;
  const diff = new PNG({ width, height });
  const mismatchPixels = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    width,
    height,
    {
      threshold: threshold ?? 0.1,
      includeAA: false,
      diffMask: true, // magenta on transparent
      alpha: 0,
    }
  );

  await fs.mkdir(path.dirname(diffOut), { recursive: true });
  await fs.writeFile(diffOut, PNG.sync.write(diff));

  const totalPixels = width * height;
  const mismatchPct = (mismatchPixels / totalPixels) * 100;
  emit({
    type: 'diff-result',
    engine,
    viewport,
    baselinePath: basePath,
    currentPath: currPath,
    diffPath: diffOut,
    mismatchPixels,
    mismatchPercentage: Number(mismatchPct.toFixed(4)),
    heightDelta,
    maskedRegions: Math.max(baseMasked, currMasked),
  });
}

async function readManifest(dir) {
  try {
    const txt = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function listShots(dir) {
  // Returns [{ engine, viewport, path }] for every PNG under dir/{engine}/.
  const shots = [];
  const engines = await fs.readdir(dir).catch(() => []);
  for (const engine of engines) {
    const engineDir = path.join(dir, engine);
    const stat = await fs.stat(engineDir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const files = await fs.readdir(engineDir);
    for (const file of files) {
      if (!file.endsWith('.png')) continue;
      shots.push({ engine, viewport: file.replace(/\.png$/, ''), path: path.join(engineDir, file) });
    }
  }
  return shots;
}

async function run() {
  const config = await readStdinJson();
  if (!config.baselineDir) throw new Error('Config missing "baselineDir".');
  if (!config.currentDir) throw new Error('Config missing "currentDir".');
  if (!config.outputDir) throw new Error('Config missing "outputDir".');

  await fs.mkdir(config.outputDir, { recursive: true });

  const baselineShots = await listShots(config.baselineDir);
  const currentShots = await listShots(config.currentDir);
  const baselineByKey = new Map(baselineShots.map((s) => [`${s.engine}/${s.viewport}`, s]));

  const pairs = [];
  for (const c of currentShots) {
    const key = `${c.engine}/${c.viewport}`;
    const b = baselineByKey.get(key);
    if (b) pairs.push({ engine: c.engine, viewport: c.viewport, basePath: b.path, currPath: c.path });
  }

  emit({
    type: 'diff-start',
    total: pairs.length,
    baselineDir: config.baselineDir,
    currentDir: config.currentDir,
  });

  let passed = 0, review = 0, regression = 0;
  for (const p of pairs) {
    const diffOut = path.join(config.outputDir, p.engine, `${p.viewport}-diff.png`);
    await runComparison(p.engine, p.viewport, p.basePath, p.currPath, diffOut, config.masks, config.threshold);
  }

  // Re-walk the emitted results to compute totals — done by the
  // frontend from the streamed events instead. Just mark complete here.
  emit({ type: 'diff-complete', total: pairs.length });
}

run().catch((err) => {
  emit({ type: 'fatal', message: err.message ?? String(err) });
  process.exit(1);
});
