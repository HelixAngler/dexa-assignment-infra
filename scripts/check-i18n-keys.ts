/**
 * Locale key parity check for the web apps under `sources/`.
 *
 * For every app that keeps its dictionaries in `src/i18n/{id,en}.ts` the
 * script reports:
 *   - keys that exist in one language of an app but not in the other,
 *   - keys whose value is blank or is not a plain string literal,
 *   - duplicate keys inside a single dictionary,
 *   - as a warning, a key whose Indonesian and English text are identical in
 *     one app while the two apps that both define that key keep them apart
 *     (usually a translation that was copied over without being translated).
 *
 * Key sets are deliberately NOT compared between apps: every app has its own
 * vocabulary (an employee sees "Absen", an HRD operator sees "Absensi"), so
 * only within-app parity is a contract.
 *
 * The dictionaries are plain TypeScript object literals, so they are read
 * with a small tokenizer that skips comments and understands string literals
 * instead of being evaluated. That keeps the script free of any dependency.
 *
 * Usage, from anywhere inside the repository:
 *   npm --prefix sources/infra run i18n
 *   node --experimental-strip-types sources/infra/scripts/check-i18n-keys.ts
 *
 * Exits 0 when every discovered app is in parity, 1 on any parity problem or
 * when no dictionary can be found at all. Only Node built-ins are used, so no
 * install step is needed.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The two languages every dictionary pair must carry. */
const LANGUAGES = ['id', 'en'] as const;

/** Sub-directory of an app that holds its dictionaries. */
const I18N_DIR = path.join('src', 'i18n');

/** One lexical unit: either a string literal (already unescaped) or a word. */
interface Token {
  kind: 'string' | 'word';
  value: string;
}

/** One parsed dictionary file. */
interface Dictionary {
  file: string;
  /** key -> value, in file order; duplicates are reported, not merged. */
  entries: Map<string, string>;
  /** Structural problems found while parsing this file. */
  problems: string[];
  /** Keys defined more than once in this file. */
  duplicates: string[];
}

const OPENERS = new Set(['{', '[', '(']);
const CLOSERS = new Set(['}', ']', ')']);
/**
 * Characters that always end a word token. They are broken out one by one so
 * that glued forms such as `};` or `'key':` still yield the structural token
 * the parser looks for.
 */
const WORD_BREAKERS = new Set(['{', '}', '[', ']', '(', ')', ',', ':']);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NUMERIC = /^[0-9]+$/;

/** Turns an escape sequence into the character it stands for. */
function unescape(char: string): string {
  switch (char) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    case '0':
      return '\0';
    default:
      return char;
  }
}

/**
 * Splits a source file into tokens. Comments are dropped, string literals
 * become one token each, everything else becomes word tokens (whitespace
 * separated, quotes and backticks introduce strings).
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      const lineEnd = source.indexOf('\n', i);
      i = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const commentEnd = source.indexOf('*/', i + 2);
      i = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== char) {
        if (source[i] === '\\' && i + 1 < source.length) {
          value += unescape(source[i + 1]);
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    let j = i;
    while (
      j < source.length &&
      !/[\s'"`]/.test(source[j]) &&
      !WORD_BREAKERS.has(source[j]) &&
      !(source[j] === '/' && (source[j + 1] === '/' || source[j + 1] === '*'))
    ) {
      j += 1;
    }
    if (j === i) {
      // A structural character that stands on its own, e.g. `};` or `,`.
      tokens.push({ kind: 'word', value: char });
      i += 1;
      continue;
    }
    tokens.push({ kind: 'word', value: source.slice(i, j) });
    i = j;
  }
  return tokens;
}

/**
 * Finds the first `export const <name> = { ... }` object literal and returns
 * the token range of its body (exclusive of the braces), or null when the
 * file has no such literal.
 */
function objectBody(tokens: Token[]): { start: number; end: number } | null {
  let declaration = -1;
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i].value === 'export' && tokens[i + 1].value === 'const') {
      declaration = i;
      break;
    }
  }
  if (declaration === -1) {
    return null;
  }
  let open = -1;
  for (let i = declaration + 2; i < tokens.length; i += 1) {
    if (tokens[i].kind === 'word' && tokens[i].value === '{') {
      open = i;
      break;
    }
  }
  if (open === -1) {
    return null;
  }
  let depth = 1;
  for (let i = open + 1; i < tokens.length; i += 1) {
    const value = tokens[i].value;
    if (OPENERS.has(value)) {
      depth += 1;
    } else if (CLOSERS.has(value)) {
      depth -= 1;
      if (depth === 0) {
        return { start: open + 1, end: i };
      }
    }
  }
  return null;
}

/** Splits a token range on the commas that sit at the outer nesting level. */
function splitEntries(tokens: Token[], start: number, end: number): Token[][] {
  const entries: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    const value = tokens[i].value;
    if (OPENERS.has(value)) {
      depth += 1;
    } else if (CLOSERS.has(value)) {
      depth -= 1;
    }
    if (value === ',' && depth === 0) {
      if (current.length > 0) {
        entries.push(current);
        current = [];
      }
      continue;
    }
    current.push(tokens[i]);
  }
  if (current.length > 0) {
    entries.push(current);
  }
  return entries;
}

/** Reads and parses one dictionary file. Never throws; problems are collected. */
function readDictionary(absolutePath: string, label: string): Dictionary {
  const dictionary: Dictionary = {
    file: label,
    entries: new Map<string, string>(),
    problems: [],
    duplicates: [],
  };
  let source: string;
  try {
    source = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    dictionary.problems.push('file could not be read');
    return dictionary;
  }
  const tokens = tokenize(source);
  const body = objectBody(tokens);
  if (body === null) {
    dictionary.problems.push('no `export const` object literal found');
    return dictionary;
  }
  for (const entry of splitEntries(tokens, body.start, body.end)) {
    const keyToken = entry[0];
    if (
      keyToken.kind === 'word' &&
      !IDENTIFIER.test(keyToken.value) &&
      !NUMERIC.test(keyToken.value)
    ) {
      dictionary.problems.push(`unexpected entry starting with "${keyToken.value}"`);
      continue;
    }
    const key = keyToken.value;
    if (entry.length < 2 || entry[1].kind !== 'word' || entry[1].value !== ':') {
      dictionary.problems.push(`key "${key}" is not followed by ":"`);
      continue;
    }
    const valueParts = entry.slice(2).filter((token) => token.kind === 'string');
    if (valueParts.length === 0) {
      dictionary.problems.push(`key "${key}" has no plain string value`);
      continue;
    }
    if (dictionary.entries.has(key)) {
      dictionary.duplicates.push(key);
      continue;
    }
    dictionary.entries.set(
      key,
      valueParts.map((token) => token.value).join(''),
    );
  }
  return dictionary;
}

/** Walks upwards from a starting directory until it finds the repo root. */
function findRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    const hasEmployeeWeb = fs.existsSync(
      path.join(current, 'sources', 'employee-web', I18N_DIR),
    );
    const hasHrdWeb = fs.existsSync(path.join(current, 'sources', 'hrd-web', I18N_DIR));
    if (hasEmployeeWeb || hasHrdWeb) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Lists the apps under `sources/` that ship an `src/i18n` dictionary pair. */
function discoverApps(repoRoot: string): string[] {
  const sourcesDir = path.join(repoRoot, 'sources');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourcesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(sourcesDir, entry.name, I18N_DIR)),
    )
    .map((entry) => entry.name)
    .sort();
}

/** Compares the two languages of one app; returns fatal problems. */
function compareLanguages(label: string, dictionaries: Map<string, Dictionary>): string[] {
  const problems: string[] = [];
  const idDict = dictionaries.get('id');
  const enDict = dictionaries.get('en');
  if (idDict === undefined || enDict === undefined) {
    return [`${label}: dictionary pair incomplete`];
  }
  for (const dict of [idDict, enDict]) {
    for (const problem of dict.problems) {
      problems.push(`${dict.file}: ${problem}`);
    }
    for (const key of [...dict.duplicates].sort()) {
      problems.push(`${dict.file}: duplicate key "${key}"`);
    }
    for (const [key, value] of dict.entries) {
      if (value.trim() === '') {
        problems.push(`${dict.file}: key "${key}" has a blank value`);
      }
    }
  }
  const idKeys = [...idDict.entries.keys()].sort();
  const enKeys = [...enDict.entries.keys()].sort();
  const missingInEn = idKeys.filter((key) => !enDict.entries.has(key));
  const missingInId = enKeys.filter((key) => !idDict.entries.has(key));
  if (missingInEn.length > 0) {
    problems.push(`${label}: en.ts is missing ${missingInEn.join(', ')}`);
  }
  if (missingInId.length > 0) {
    problems.push(`${label}: id.ts is missing ${missingInId.join(', ')}`);
  }
  return problems;
}

/**
 * Flags a key that one app keeps identical in both languages while the other
 * app, which defines the same key, translates it. Purely advisory: the same
 * word can legitimately be spelled alike in both languages.
 */
function findUntranslatedLookalikes(
  apps: string[],
  data: Map<string, Map<string, Dictionary>>,
): string[] {
  const warnings: string[] = [];
  const sharedKeys = new Set<string>();
  for (const dictionaries of data.values()) {
    for (const [lang, dict] of dictionaries) {
      if (lang === 'id') {
        for (const key of dict.entries.keys()) {
          sharedKeys.add(key);
        }
      }
    }
  }
  for (const key of [...sharedKeys].sort()) {
    const definedIn = apps.filter(
      (app) =>
        data.get(app)?.get('id')?.entries.has(key) === true &&
        data.get(app)?.get('en')?.entries.has(key) === true,
    );
    if (definedIn.length < 2) {
      continue;
    }
    const identicalIn = definedIn.filter(
      (app) =>
        data.get(app)?.get('id')?.entries.get(key) ===
        data.get(app)?.get('en')?.entries.get(key),
    );
    const translatedIn = definedIn.filter(
      (app) =>
        data.get(app)?.get('id')?.entries.get(key) !==
        data.get(app)?.get('en')?.entries.get(key),
    );
    if (identicalIn.length > 0 && translatedIn.length > 0) {
      warnings.push(
        `"${key}": identical in ${identicalIn.join(', ')} but translated in ${translatedIn.join(', ')}`,
      );
    }
  }
  return warnings;
}

function main(): void {
  const scriptDir = path.dirname(process.argv[1] ?? '.');
  const repoRoot = findRepoRoot(scriptDir) ?? findRepoRoot(process.cwd());
  if (repoRoot === null) {
    console.error('Could not locate the repository root from this script.');
    process.exit(1);
  }

  const apps = discoverApps(repoRoot);
  if (apps.length === 0) {
    console.error('No app with a src/i18n dictionary pair found under sources/.');
    process.exit(1);
  }

  const problems: string[] = [];
  const warnings: string[] = [];
  const data = new Map<string, Map<string, Dictionary>>();

  for (const app of apps) {
    const appDir = path.join(repoRoot, 'sources', app, I18N_DIR);
    const dictionaries = new Map<string, Dictionary>();
    for (const lang of LANGUAGES) {
      const file = path.join(appDir, `${lang}.ts`);
      const label = path.relative(repoRoot, file);
      if (!fs.existsSync(file)) {
        problems.push(`${app}: ${label} not found`);
        continue;
      }
      dictionaries.set(lang, readDictionary(file, label));
    }
    data.set(app, dictionaries);
    problems.push(...compareLanguages(app, dictionaries));
  }

  warnings.push(...findUntranslatedLookalikes(apps, data));

  for (const problem of [...problems].sort()) {
    console.error(`ERROR ${problem}`);
  }
  for (const warning of [...warnings].sort()) {
    console.warn(`WARN  ${warning}`);
  }

  const summary = apps
    .map((app) => {
      const idDict = data.get(app)?.get('id');
      const count = idDict === undefined ? 0 : idDict.entries.size;
      return `${app}=${count} keys`;
    })
    .join(', ');

  if (problems.length > 0) {
    console.error(
      `Locale key parity FAILED for ${problems.length} problem(s) (${summary}).`,
    );
    process.exit(1);
  }

  console.log(
    `Locale key parity ok: ${summary}; ${warnings.length} warning(s).`,
  );
}

main();
