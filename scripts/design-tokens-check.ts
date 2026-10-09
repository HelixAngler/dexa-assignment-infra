/**
 * Design-token parity check: the reference stylesheet and both applications
 * must declare the same custom properties with the same values.
 *
 * For the three token stylesheets (reference, employee app, console app) the
 * script verifies that:
 *   - all three files exist and parse into custom-property maps,
 *   - the three name → value maps are identical (same names, same values),
 *   - every token the token contract requires is present in all three files,
 *   - each present token's value matches the contract's literal.
 *
 * Contract values are compared structurally rather than byte-for-byte:
 * whitespace, letter case and a leading decimal point never change a meaning,
 * and a bare number in the contract matches the same number written with a
 * px unit. A contract cell of the form "12 / 16 px" (size paired with its
 * line-height) is satisfied either by one value "12px/16px" or by the value
 * "12px" next to a `<name>-line-height` companion token holding "16px".
 *
 * Output: one ERROR line per problem, then the summary line
 * `tokens: 3 files, NN names, identical: yes, contract coverage: NN/NN`.
 * Exits 0 only when every check passes; otherwise it exits 1.
 *
 * Usage, from anywhere inside the repository:
 *   npm --prefix sources/infra run design:tokens-check
 *   node --experimental-strip-types <this file>
 *
 * Only Node built-ins are used, so no install step is needed.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Prefix for every diagnostic line this script prints. */
const SCRIPT = 'design-tokens-check.ts';

const REFERENCE_DIR = path.join('specs', '002-ui-ux-redesign');
/** Token contract the three stylesheets must satisfy. */
const CONTRACT_FILE = path.join(REFERENCE_DIR, 'contracts', 'design-tokens.md');
/** The three stylesheets under parity, in report order. */
const TOKEN_FILES: { label: string; rel: string }[] = [
  { label: 'design reference', rel: path.join(REFERENCE_DIR, 'design', 'tokens.css') },
  {
    label: 'employee app',
    rel: path.join('sources', 'employee-web', 'src', 'styles', 'tokens.css'),
  },
  { label: 'console app', rel: path.join('sources', 'hrd-web', 'src', 'styles', 'tokens.css') },
];

/** One stylesheet's parsed state. */
interface TokenFile {
  label: string;
  rel: string;
  found: boolean;
  /** name → raw value, first definition wins. */
  tokens: Map<string, string>;
  /** Names declared more than once in this file. */
  duplicates: string[];
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

/** Lower-cases, drops all whitespace and spells out leading decimal points. */
function canonicalize(value: string): string {
  const noWhitespace = value.trim().toLowerCase().replace(/\s+/g, '');
  return noWhitespace.replace(/(^|[^\d])\.(?=\d)/g, (_match, prefix: string) => `${prefix}0.`);
}

/** Splits a canonical value into comparable atoms: hex, numbers+units, words. */
function atoms(value: string): string[] {
  return value.match(/#[0-9a-f]+|[0-9]*\.?[0-9]+[a-z%]*|[a-z]+|[^\w]/g) ?? [];
}

/**
 * True when the stylesheet value carries the same meaning as the contract's
 * literal: equal after canonicalization, or atom-for-atom equal with a bare
 * contract number accepting the same number written with a unit.
 */
function valueMatches(expected: string, actual: string): boolean {
  const want = canonicalize(expected).replace(/^[≤≥<>~=]+/, '');
  const got = canonicalize(actual);
  if (want === got) {
    return true;
  }
  const wantAtoms = atoms(want);
  const gotAtoms = atoms(got);
  if (wantAtoms.length !== gotAtoms.length) {
    return false;
  }
  const numeric = /^(\d*\.?\d+)([a-z%]*)$/;
  for (let i = 0; i < wantAtoms.length; i += 1) {
    const left = wantAtoms[i];
    const right = gotAtoms[i];
    const leftNumber = numeric.exec(left);
    const rightNumber = numeric.exec(right);
    if (leftNumber !== null && rightNumber !== null) {
      const sameNumber = Number.parseFloat(leftNumber[1]) === Number.parseFloat(rightNumber[1]);
      const compatibleUnit = leftNumber[2] === '' || leftNumber[2] === rightNumber[2];
      if (!sameNumber || !compatibleUnit) {
        return false;
      }
      continue;
    }
    if (left !== right) {
      return false;
    }
  }
  return true;
}

/** Extracts the custom properties of one stylesheet. */
function parseCustomProperties(css: string): { tokens: Map<string, string>; duplicates: string[] } {
  const tokens = new Map<string, string>();
  const duplicates: string[] = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const hit of withoutComments.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;}]+)/g)) {
    // Store bare names (without the `--` sigil) so they line up with the
    // contract's spelling.
    const name = hit[1].slice(2);
    const value = hit[2].trim();
    if (tokens.has(name)) {
      duplicates.push(name);
      continue;
    }
    tokens.set(name, value);
  }
  return { tokens, duplicates };
}

/** True when a candidate contract value looks like a real literal. */
function looksLikeValue(value: string): boolean {
  if (value.includes('`')) {
    return false;
  }
  return /^(?:#|\d)/.test(value);
}

/**
 * Reads the contract's token names; when the contract states a literal value
 * next to the name, the literal is kept for the value check.
 */
function parseContract(markdown: string): Map<string, string | undefined> {
  const names = new Map<string, string | undefined>();
  const put = (name: string, value: string | undefined): void => {
    if (!names.has(name)) {
      names.set(name, value);
      return;
    }
    if (names.get(name) === undefined && value !== undefined) {
      names.set(name, value);
    }
  };
  const valueAfter = (line: string, from: number): string | undefined => {
    const rest = line.slice(from);
    let cut = rest.length;
    for (const delimiter of ['\n', '·', '(', ';', '—']) {
      const at = rest.indexOf(delimiter);
      if (at !== -1 && at < cut) {
        cut = at;
      }
    }
    const raw = rest
      .slice(0, cut)
      .trim()
      .replace(/^[≤≥<>~=]+/, '')
      .trim();
    return looksLikeValue(raw) ? raw : undefined;
  };
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('|')) {
      const row = /^\|\s*`([a-z][a-z0-9-]*)`\s*\|\s*([^|]*)\|/.exec(line);
      if (row !== null) {
        const cell = row[2].replace(/`/g, '').trim();
        put(row[1], looksLikeValue(cell) ? cell : undefined);
      }
      continue;
    }
    for (const span of line.matchAll(/`([a-z][a-z0-9-]*-[a-z0-9-]*)`/g)) {
      put(span[1], valueAfter(line, span.index + span[0].length));
    }
  }
  return names;
}

/**
 * Verifies one contract entry against one file: presence plus, when the
 * contract states a literal, the value. Returns a problem description or null.
 */
function checkContractEntry(
  name: string,
  expected: string | undefined,
  file: TokenFile,
): string | null {
  const actual = file.tokens.get(name);
  if (actual === undefined) {
    return null;
  }
  if (expected === undefined) {
    return null;
  }
  if (valueMatches(expected, actual)) {
    return null;
  }
  const paired = /^\s*([^/]+?)\s*\/\s*(.+?)\s*$/.exec(expected);
  if (paired !== null && valueMatches(paired[1], actual)) {
    const companion = file.tokens.get(`${name}-line-height`);
    if (companion !== undefined && valueMatches(paired[2], companion)) {
      return null;
    }
    return (
      `token "${name}": expected "${expected}" (or "${paired[1]}" plus ` +
      `"${name}-line-height: ${paired[2]}") actual "${actual}" in ${file.rel}`
    );
  }
  return `token "${name}": expected "${expected}" actual "${actual}" in ${file.rel}`;
}

/** Compares every pair of present files; returns one line per divergence. */
function compareFiles(files: TokenFile[]): string[] {
  const problems: string[] = [];
  const present = files.filter((file) => file.found);
  if (present.length < 2) {
    return problems;
  }
  const union = new Set<string>();
  for (const file of present) {
    for (const name of file.tokens.keys()) {
      union.add(name);
    }
  }
  for (const name of [...union].sort()) {
    const owners = present.filter((file) => file.tokens.has(name));
    if (owners.length !== present.length) {
      const missing = present
        .filter((file) => !file.tokens.has(name))
        .map((file) => file.rel)
        .join(', ');
      problems.push(`token "${name}" missing from ${missing}`);
      continue;
    }
    const reference = owners[0];
    const referenceValue = canonicalize(reference.tokens.get(name) ?? '');
    for (const other of owners.slice(1)) {
      const otherValue = canonicalize(other.tokens.get(name) ?? '');
      if (referenceValue !== otherValue) {
        problems.push(
          `token "${name}" differs: ${reference.rel}="${reference.tokens.get(name)}", ` +
            `${other.rel}="${other.tokens.get(name)}"`,
        );
      }
    }
  }
  return problems;
}

function main(): void {
  const scriptPath =
    process.argv[1] === undefined ? process.cwd() : path.dirname(path.resolve(process.argv[1]));
  const repoRoot = findRepoRoot(scriptPath) ?? findRepoRoot(process.cwd());
  if (repoRoot === null) {
    console.error(`${SCRIPT}: could not locate the repository root from this script.`);
    process.exit(1);
  }

  const errors: string[] = [];

  const contractText = readText(path.join(repoRoot, CONTRACT_FILE));
  if (contractText === null) {
    console.error(`${SCRIPT}: token contract not found at ${CONTRACT_FILE}`);
    process.exit(1);
  }
  const contract = parseContract(contractText);
  if (contract.size === 0) {
    console.error(`${SCRIPT}: no token names parsed out of ${CONTRACT_FILE}`);
    process.exit(1);
  }

  const files: TokenFile[] = TOKEN_FILES.map(({ label, rel }) => {
    const source = readText(path.join(repoRoot, rel));
    if (source === null) {
      errors.push(`${rel} not found`);
      return { label, rel, found: false, tokens: new Map<string, string>(), duplicates: [] };
    }
    const { tokens, duplicates } = parseCustomProperties(source);
    for (const name of duplicates) {
      errors.push(`token "${name}" declared more than once in ${rel}`);
    }
    return { label, rel, found: true, tokens, duplicates };
  });

  errors.push(...compareFiles(files));

  let covered = 0;
  const allFilesFound = files.every((file) => file.found);
  for (const [name, expected] of contract) {
    const absent = files.filter((file) => !file.found || !file.tokens.has(name));
    if (absent.length > 0) {
      if (files.some((file) => file.found && !file.tokens.has(name))) {
        const where = absent
          .filter((file) => file.found)
          .map((file) => file.rel)
          .join(', ');
        errors.push(`required token "${name}" missing from ${where}`);
      }
      continue;
    }
    covered += 1;
    for (const file of files) {
      const problem = checkContractEntry(name, expected, file);
      if (problem !== null) {
        errors.push(problem);
      }
    }
  }

  for (const error of errors) {
    console.error(`${SCRIPT}: ERROR ${error}`);
  }

  const found = files.filter((file) => file.found).length;
  const names = new Set<string>();
  for (const file of files) {
    for (const name of file.tokens.keys()) {
      names.add(name);
    }
  }
  const identical = allFilesFound && compareFiles(files).length === 0;
  const filesPart =
    found === TOKEN_FILES.length ? `${found} files` : `${found}/${TOKEN_FILES.length} files`;
  const summary =
    `tokens: ${filesPart}, ${names.size} names, identical: ${identical ? 'yes' : 'no'}, ` +
    `contract coverage: ${covered}/${contract.size}`;
  console.log(summary);

  process.exit(errors.length === 0 ? 0 : 1);
}

main();
