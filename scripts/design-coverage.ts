/**
 * Screen-id coverage check for the static reference pages and the visual-QA
 * harness.
 *
 * For every id of the screen inventory the script verifies two things:
 *   - reference page: the reference index enumerates the id and links it to a
 *     page file that exists on disk and carries the id as an element id
 *     (state variants are anchors inside their group file, e.g.
 *     `absen.html#emp.absen.conflict`);
 *   - qa entry: at least one test under the visual-QA harness exercises the
 *     id — either by naming it in a string literal or by iterating the shared
 *     screen map the harness keeps in design-qa.
 *
 * The id list itself is parsed from the inventory table and then cross-checked
 * against the design-qa screen map, so drift between the two is reported
 * instead of silently tolerated.
 *
 * Output: a per-id table with both check columns, then the missing ids with a
 * reason each, then the summary line `NN/23 screen ids covered`. Exits 0 only
 * when every id has both marks; otherwise it exits 1.
 *
 * Usage, from anywhere inside the repository:
 *   npm --prefix sources/infra run design:coverage
 *   node --experimental-strip-types sources/infra/scripts/design-coverage.ts
 *
 * Only Node built-ins are used, so no install step is needed.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Prefix for every diagnostic line this script prints. */
const SCRIPT = 'design-coverage.ts';

/** The inventory enumerates this many ids: 13 employee + 10 console. */
const EXPECTED_ID_COUNT = 23;

const REFERENCE_DIR = path.join('specs', '002-ui-ux-redesign');
/** Table holding the authoritative id list. */
const INVENTORY_FILE = path.join(REFERENCE_DIR, 'contracts', 'screen-inventory.md');
/** Root of the static reference pages; index.html maps every id to its page anchor. */
const DESIGN_DIR = path.join(REFERENCE_DIR, 'design');
const INDEX_FILE = path.join(DESIGN_DIR, 'index.html');
/** Subdirectories of the reference root that hold the page files. */
const MOCKUP_SUBDIRS = ['employee-app', 'hrd-app'];
/** Spec directory of the visual-QA harness. */
const QA_SPECS_DIR = path.join('sources', 'infra', 'design-qa', 'specs');
/** Screen map module of the visual-QA harness, read for the cross-check. */
const SCREEN_MAP_FILE = path.join('sources', 'infra', 'design-qa', 'screens.ts');

/** Shape an inventory id must have, e.g. `emp.absen.conflict`. */
const ID_SHAPE = /^(?:emp|hrd)(?:\.[a-z0-9-]+)+$/;

/** One id's two marks (reference page, QA entry) plus a reason when the first failed. */
interface CoverageRow {
  id: string;
  mockup: boolean;
  qa: boolean;
  mockupReason: string | null;
}

/** What one spec file says about the ids it exercises. */
interface SpecFacts {
  /** Ids the file names in a quoted string literal. */
  literals: Set<string>;
  /** The file iterates the whole shared screen map. */
  coversAll: boolean;
  /** The file iterates the shared screen map restricted to the employee app. */
  coversEmployee: boolean;
  /** The file iterates the shared screen map restricted to the console app. */
  coversConsole: boolean;
}

/** Walks upwards until it finds the repository root. */
function findRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    const looksLikeRoot =
      fs.existsSync(path.join(current, 'sources', 'infra', 'package.json')) &&
      fs.existsSync(path.join(current, 'specs'));
    if (looksLikeRoot) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Reads a file; returns null when it cannot be read. */
function readText(absolutePath: string): string | null {
  try {
    return fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

/** Parses the inventory table; returns the ids in document order. */
function parseInventoryIds(text: string): { ids: string[]; problems: string[] } {
  const ids: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const row = /^\|\s*\d+\s*\|\s*`([^`]+)`\s*\|/.exec(rawLine.trim());
    if (row === null) {
      continue;
    }
    const id = row[1].trim();
    if (!ID_SHAPE.test(id)) {
      problems.push(`inventory row lists an unrecognized id: "${id}"`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`inventory lists the id "${id}" more than once`);
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return { ids, problems };
}

/** Parses the design reference index into id → href (anchor link). */
function parseIndexEntries(html: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const tag of html.match(/<a\b[^>]*>/g) ?? []) {
    const id = /\bdata-screen-id="([^"]+)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (id !== undefined && href !== undefined) {
      entries.set(id, href);
    }
  }
  return entries;
}

/** Recursively lists every `.html` file under the given directories. */
function collectHtmlFiles(dirs: string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        files.push(full);
      }
    }
  };
  for (const dir of dirs) {
    walk(dir);
  }
  return files;
}

/** Maps each id to the first reference page that carries it as an element id. */
function buildAnchorIndex(designDir: string): Map<string, string> {
  const index = new Map<string, string>();
  const dirs = MOCKUP_SUBDIRS.map((subdir) => path.join(designDir, subdir));
  for (const file of collectHtmlFiles(dirs)) {
    const source = readText(file);
    if (source === null) {
      continue;
    }
    for (const id of source.matchAll(/\bid="((?:emp|hrd)\.[a-z0-9.-]+)"/g)) {
      if (!index.has(id[1])) {
        index.set(id[1], path.relative(designDir, file));
      }
    }
  }
  return index;
}

/** Checks the index entry and the page file/anchor behind one id. */
function checkMockup(
  id: string,
  designDir: string,
  indexEntries: Map<string, string> | null,
  anchorIndex: Map<string, string> | null,
): { ok: boolean; reason: string | null } {
  if (indexEntries === null) {
    const file = anchorIndex?.get(id);
    if (file === undefined) {
      return { ok: false, reason: 'no mockup file carries this id as an anchor' };
    }
    return { ok: true, reason: null };
  }
  const href = indexEntries.get(id);
  if (href === undefined) {
    return { ok: false, reason: 'not enumerated in the design index' };
  }
  const hash = href.indexOf('#');
  const filePart = hash === -1 ? href : href.slice(0, hash);
  const fragment = hash === -1 ? null : href.slice(hash + 1);
  const absolute = path.join(designDir, filePart);
  const source = readText(absolute);
  if (source === null) {
    return { ok: false, reason: `mockup file missing: ${filePart}` };
  }
  if (fragment !== null && !source.includes(`id="${fragment}"`)) {
    return { ok: false, reason: `anchor #${fragment} missing in ${filePart}` };
  }
  return { ok: true, reason: null };
}

/** Blanks out comments while keeping string literals intact. */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const char = source[i];
    if (quote !== null) {
      out += char;
      if (char === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      const lineEnd = source.indexOf('\n', i);
      i = lineEnd === -1 ? source.length : lineEnd;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const commentEnd = source.indexOf('*/', i + 2);
      i = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** Extracts one spec file's id coverage facts. */
function specFacts(source: string): SpecFacts {
  const code = stripComments(source);
  const literals = new Set<string>();
  for (const hit of code.matchAll(/(['"`])((?:emp|hrd)(?:\.[a-z0-9-]+)+)\1/g)) {
    literals.add(hit[2]);
  }
  const importsSharedMap = /from\s+['"][^'"]*\/screens['"]/.test(code);
  const iteratesWholeMap =
    /\bscreenIds\b/.test(code) ||
    /\ballScreens\s*\(/.test(code) ||
    /Object\.(?:keys|entries)\s*\(\s*screens\s*\)/.test(code) ||
    /for\s*\([^)]*\bin\s+screens\b/.test(code);
  return {
    literals,
    coversAll: importsSharedMap && iteratesWholeMap,
    coversEmployee: importsSharedMap && /\bscreensOf\s*\(\s*['"]employee['"]/.test(code),
    coversConsole: importsSharedMap && /\bscreensOf\s*\(\s*['"]hrd['"]/.test(code),
  };
}

/** Recursively lists every spec file under the harness spec directory. */
function collectSpecFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files.sort();
}

/** True when at least one spec file exercises the id. */
function hasQaEntry(id: string, facts: SpecFacts[]): boolean {
  const employee = id.startsWith('emp.');
  for (const fact of facts) {
    if (
      fact.literals.has(id) ||
      fact.coversAll ||
      (employee && fact.coversEmployee) ||
      (!employee && fact.coversConsole)
    ) {
      return true;
    }
  }
  return false;
}

/** Reads the `screenIds` array out of the harness screen map module. */
function parseScreenMapIds(text: string): string[] | null {
  const block = /export const screenIds\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (block === null) {
    return null;
  }
  return [...block[1].matchAll(/'([^']+)'/g)].map((hit) => hit[1]);
}

function main(): void {
  const scriptPath =
    process.argv[1] === undefined ? process.cwd() : path.dirname(path.resolve(process.argv[1]));
  const repoRoot = findRepoRoot(scriptPath) ?? findRepoRoot(process.cwd());
  if (repoRoot === null) {
    console.error(`${SCRIPT}: could not locate the repository root from this script.`);
    process.exit(1);
  }

  const problems: string[] = [];

  const inventoryText = readText(path.join(repoRoot, INVENTORY_FILE));
  if (inventoryText === null) {
    console.error(`${SCRIPT}: screen inventory not found at ${INVENTORY_FILE}`);
    process.exit(1);
  }
  const { ids, problems: inventoryProblems } = parseInventoryIds(inventoryText);
  problems.push(...inventoryProblems);
  if (ids.length === 0) {
    console.error(`${SCRIPT}: no screen ids found in the inventory table at ${INVENTORY_FILE}`);
    process.exit(1);
  }
  if (ids.length !== EXPECTED_ID_COUNT) {
    problems.push(
      `inventory enumerates ${ids.length} ids, expected ${EXPECTED_ID_COUNT} ` +
        `(13 employee + 10 console)`,
    );
  }

  const screenMapText = readText(path.join(repoRoot, SCREEN_MAP_FILE));
  if (screenMapText === null) {
    problems.push(`screen map not found at ${SCREEN_MAP_FILE}`);
  } else {
    const mapIds = parseScreenMapIds(screenMapText);
    if (mapIds === null) {
      problems.push(`could not read the id array out of ${SCREEN_MAP_FILE}`);
    } else {
      const inventorySet = new Set(ids);
      const mapSet = new Set(mapIds);
      const absentFromMap = ids.filter((id) => !mapSet.has(id));
      const absentFromInventory = mapIds.filter((id) => !inventorySet.has(id));
      if (absentFromMap.length > 0) {
        problems.push(`ids missing from the design-qa screen map: ${absentFromMap.join(', ')}`);
      }
      if (absentFromInventory.length > 0) {
        problems.push(
          `ids in the design-qa screen map but not in the inventory: ${absentFromInventory.join(', ')}`,
        );
      }
    }
  }

  const designDir = path.join(repoRoot, DESIGN_DIR);
  const indexText = readText(path.join(repoRoot, INDEX_FILE));
  const indexEntries = indexText === null ? null : parseIndexEntries(indexText);
  if (indexText === null) {
    problems.push(`design index not found at ${INDEX_FILE}; falling back to scanning mockup files`);
  }
  const anchorIndex = indexEntries === null ? buildAnchorIndex(designDir) : null;

  const specFiles = collectSpecFiles(path.join(repoRoot, QA_SPECS_DIR));
  if (specFiles.length === 0) {
    problems.push(`no spec files found under ${QA_SPECS_DIR}`);
  }
  const facts = specFiles.map((file) => specFacts(readText(file) ?? ''));

  const rows: CoverageRow[] = ids.map((id) => {
    const mockup = checkMockup(id, designDir, indexEntries, anchorIndex);
    return {
      id,
      mockup: mockup.ok,
      mockupReason: mockup.reason,
      qa: hasQaEntry(id, facts),
    };
  });

  const idWidth = Math.max(...rows.map((row) => row.id.length), 'screen id'.length);
  console.log(`${'screen id'.padEnd(idWidth)}  mockup  qa entry`);
  console.log(`${'-'.repeat(idWidth)}  -------  --------`);
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(idWidth)}    ${row.mockup ? '✓' : '✗'}      ${row.qa ? '✓' : '✗'}`,
    );
  }
  console.log('');

  const missingMockup = rows.filter((row) => !row.mockup);
  const missingQa = rows.filter((row) => !row.qa);
  if (missingMockup.length > 0) {
    for (const row of missingMockup) {
      console.error(`${SCRIPT}: ERROR missing mockup for ${row.id}: ${row.mockupReason ?? ''}`);
    }
  }
  if (missingQa.length > 0) {
    console.error(
      `${SCRIPT}: ERROR missing QA entry for ${missingQa.length} id(s): ` +
        missingQa.map((row) => row.id).join(', '),
    );
  }
  for (const problem of problems) {
    console.error(`${SCRIPT}: ERROR ${problem}`);
  }

  const covered = rows.filter((row) => row.mockup && row.qa).length;
  if (covered === EXPECTED_ID_COUNT && problems.length === 0) {
    console.log(`${EXPECTED_ID_COUNT}/${EXPECTED_ID_COUNT} screen ids covered`);
    process.exit(0);
  }
  console.log(`${covered}/${EXPECTED_ID_COUNT} screen ids covered`);
  process.exit(1);
}

main();
