/**
 * Fixture accounts for the punch/summary load run, and the teardown that
 * removes them again.
 *
 * Two modes, both idempotent and both scoped to one marker:
 *
 *   node load/seed.js provision [count]  create/refresh fixture employees
 *   node load/seed.js cleanup             drop fixture employees and everything
 *                                         hanging off them
 *
 * Provision upserts `count` (default 5000) employees on their unique marker
 * address `loadtest-NNNNN@loadtest.invalid`, stores one shared argon2id hash
 * of LOADTEST_PASSWORD (default LoadTest!2026) using the same parameters the
 * identity service writes with, wipes any attendance rows a previous run left
 * on those accounts and drops their stale sign-in sessions from Redis, so a
 * run always starts with every fixture employee clocked out and signed out.
 *
 * Cleanup runs load/cleanup.sql (employees + attendance rows + profile events,
 * marker-scoped) and then deletes the Redis sign-in sessions that belonged to
 * those employees. Nothing outside the marker is ever read or written, so
 * demo accounts and other test data are untouched.
 *
 * Both modes talk to the running local stack through docker exec:
 * main database in container infra-postgres-main-1, session store in
 * infra-redis-1.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const argon2 = require('argon2');

const PSQL_CONTAINER = 'infra-postgres-main-1';
const REDIS_CONTAINER = 'infra-redis-1';
const DB_USER = 'wfh';
const DB_NAME = 'wfh_main';

/** Address marker shared by every fixture row; also the SQL scoping key. */
const MARKER_SQL = "email LIKE 'loadtest-%@loadtest.invalid'";
const DEFAULT_COUNT = 5000;
const DEFAULT_PASSWORD = 'LoadTest!2026';

/** Same argon2id parameters the identity service hashes passwords with. */
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

const psql = (sql) =>
  execFileSync(
    'docker',
    ['exec', '-i', PSQL_CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', DB_USER, '-d', DB_NAME, '-t', '-A', '-c', sql],
    { encoding: 'utf8' },
  ).trim();

const psqlFile = (sql) =>
  execFileSync(
    'docker',
    ['exec', '-i', PSQL_CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', DB_USER, '-d', DB_NAME, '-t', '-A', '-f', '-'],
    { encoding: 'utf8', input: sql },
  ).trim();

const selectValues = (sql) =>
  psql(sql)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/**
 * Deletes the Redis sign-in sessions of the given employee ids: the per
 * employee token index holds every token that was issued, so one pass removes
 * both the session records and the index itself. Ids come from the database
 * before the rows are dropped; ids that hold no sessions simply contribute
 * nothing.
 */
function dropSignIns(employeeIds) {
  if (employeeIds.length === 0) {
    console.log('seed.js: no fixture employees, nothing to sign out');
    return 0;
  }
  const script = [
    "local removed = 0",
    'for i = 1, #ARGV do',
    "  local indexKey = 'emp-sess:' .. ARGV[i]",
    "  local tokens = redis.call('SMEMBERS', indexKey)",
    '  for _, token in ipairs(tokens) do',
    "    removed = removed + redis.call('DEL', 'sess:' .. token)",
    '  end',
    "  redis.call('DEL', indexKey)",
    'end',
    'return removed',
  ].join('\n');
  const out = execFileSync(
    'docker',
    ['exec', '-i', REDIS_CONTAINER, 'redis-cli', 'EVAL', script, '0', ...employeeIds],
    { encoding: 'utf8' },
  ).trim();
  const removed = Number(out);
  console.log(`seed.js: removed ${removed} sign-in session(s) from the session store`);
  return Number.isFinite(removed) ? removed : 0;
}

const fixtureIds = () => selectValues(`SELECT id FROM employees WHERE ${MARKER_SQL} ORDER BY email;`);

async function provision(count, password) {
  const hash = await argon2.hash(password, HASH_OPTIONS);
  if (!hash.startsWith('$argon2id$')) {
    throw new Error('password hash for the fixture accounts is not an argon2id PHC string');
  }
  const inserted = psql(
    [
      'INSERT INTO employees (name, email, position, phone, status, role, password_hash, must_change_password, auth_provider)',
      "SELECT 'Load Test ' || lpad(n::text, 5, '0'),",
      "       'loadtest-' || lpad(n::text, 5, '0') || '@loadtest.invalid',",
      "       'Load Tester',",
      "       '+62-811-' || lpad(n::text, 7, '0'),",
      "       'active', 'employee',",
      `       $lh$${hash}$lh$,`,
      "       false, 'local'",
      `FROM generate_series(1, ${count}) AS n`,
      'ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash;',
    ].join('\n'),
  );
  console.log(`seed.js: upsert of ${count} fixture account(s): ${inserted}`);

  // A fixture employee must start every run clocked out, so any rows a
  // previous run left behind go before the load driver starts.
  const sessions = psql(
    `DELETE FROM attendance_sessions WHERE employee_id IN (SELECT id FROM employees WHERE ${MARKER_SQL});`,
  );
  console.log(`seed.js: attendance rows cleared for the fixture accounts: ${sessions}`);

  dropSignIns(fixtureIds());

  const total = selectValues(`SELECT count(*) FROM employees WHERE ${MARKER_SQL};`)[0];
  const rows = selectValues(`SELECT count(*) FROM attendance_sessions WHERE employee_id IN (SELECT id FROM employees WHERE ${MARKER_SQL});`)[0];
  console.log(`seed.js: ${total} fixture employee(s) present, ${rows} attendance row(s) among them`);
}

function cleanup() {
  const ids = fixtureIds();
  dropSignIns(ids);
  const sql = readFileSync(path.join(__dirname, 'cleanup.sql'), 'utf8');
  console.log(`seed.js: cleanup.sql says:\n${psqlFile(sql)}`);
  const left = selectValues(`SELECT count(*) FROM employees WHERE ${MARKER_SQL};`)[0];
  const rows = selectValues(`SELECT count(*) FROM attendance_sessions WHERE employee_id IN (SELECT id FROM employees WHERE ${MARKER_SQL});`)[0];
  console.log(`seed.js: after cleanup ${left} fixture employee(s) and ${rows} attendance row(s) remain`);
}

async function main() {
  const mode = process.argv[2] || 'provision';
  if (mode === 'cleanup') {
    cleanup();
    return;
  }
  if (mode !== 'provision') {
    throw new Error(`unknown mode "${mode}"; expected provision or cleanup`);
  }
  const count = Number(process.argv[3] || process.env.COUNT || DEFAULT_COUNT);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`count must be a positive integer, got ${count}`);
  }
  const password = process.env.LOADTEST_PASSWORD || DEFAULT_PASSWORD;
  await provision(count, password);
}

main().catch((error) => {
  console.error(`seed.js: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
