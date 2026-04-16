import { promises as fs } from 'node:fs';
import path from 'node:path';

export function now() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

export async function writeText(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, data);
}

export function finding(check, severity, message, extra = {}) {
  return { check, severity, message, ...extra };
}

export function truncate(s, n = 120) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
