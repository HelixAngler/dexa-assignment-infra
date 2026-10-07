/**
 * Compares translation keys across the locale files of every web app and
 * fails when two locale files of the same app do not expose identical keys.
 *
 * Usage (from anywhere inside the repository):
 *   node sources/infra/scripts/check-i18n-keys.ts
 *
 * The script only uses Node built-ins, so it needs no npm install step.
 */
import fs from 'node:fs';
import path from 'node:path';

const WEB_APPS = ['employee-web', 'hrd-web'];

const LOCALE_DIR_NAMES = new Set(['i18n', 'locales', 'translations']);

function findRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(current, 'sources', 'employee-web'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function collectJsonFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

function listLocaleFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (LOCALE_DIR_NAMES.has(entry.name)) {
      files.push(...collectJsonFiles(fullPath));
    } else {
      files.push(...listLocaleFiles(fullPath));
    }
  }
  return files;
}

function flattenKeys(value: unknown, prefix: string, into: Set<string>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flattenKeys(child, prefix === '' ? key : `${prefix}.${key}`, into);
    }
    return;
  }
  if (prefix !== '') {
    into.add(prefix);
  }
}

function keysOf(file: string): Set<string> {
  const raw = fs.readFileSync(file, 'utf8');
  const data: unknown = JSON.parse(raw);
  const keys = new Set<string>();
  flattenKeys(data, '', keys);
  return keys;
}

function main(): void {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === null) {
    console.error('Could not locate the repository root from the current directory.');
    process.exit(1);
  }

  let compared = 0;
  let failures = 0;

  for (const app of WEB_APPS) {
    const srcDir = path.join(repoRoot, 'sources', app, 'src');
    if (!fs.existsSync(srcDir)) {
      console.log(`${app}: no src directory found, skipping.`);
      continue;
    }

    const localeFiles = listLocaleFiles(srcDir).sort();
    if (localeFiles.length < 2) {
      console.log(`${app}: found ${localeFiles.length} locale file(s), nothing to compare.`);
      continue;
    }

    const baselinePath = localeFiles[0];
    const baselineLabel = path.relative(repoRoot, baselinePath);
    const baselineKeys = keysOf(baselinePath);

    for (const file of localeFiles.slice(1)) {
      compared += 1;
      const label = path.relative(repoRoot, file);
      const keys = keysOf(file);
      const missing = [...baselineKeys].filter((key) => !keys.has(key));
      const extra = [...keys].filter((key) => !baselineKeys.has(key));
      if (missing.length === 0 && extra.length === 0) {
        continue;
      }
      failures += 1;
      console.error(`${app}: ${label} differs from ${baselineLabel}`);
      if (missing.length > 0) {
        console.error(`  missing keys: ${missing.join(', ')}`);
      }
      if (extra.length > 0) {
        console.error(`  extra keys: ${extra.join(', ')}`);
      }
    }
  }

  if (failures > 0) {
    console.error(`Locale key parity failed for ${failures} file(s).`);
    process.exit(1);
  }

  if (compared > 0) {
    console.log(`Locale keys are in parity (${compared} file(s) compared).`);
  } else {
    console.log('No locale file pairs found; parity check skipped.');
  }
}

main();
