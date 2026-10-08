import { execFileSync } from 'node:child_process';

import { expect, test, type APIResponse } from '@playwright/test';

/**
 * Request-level contract coverage for employee sign-in and the punch flow.
 *
 * Everything is driven through the public edge (the baseURL in the e2e
 * config), so the reverse proxy, the session cookie handling and the two
 * services are all exercised the way a browser would exercise them. No browser
 * is launched: only API request contexts are used.
 *
 * The suite owns two pieces of shared state and therefore resets them itself:
 * the sign-in failure counter (a Redis key) and today's punch rows of the
 * demo employee. Both are cleared before and after the run, which keeps the
 * file re-runnable.
 */

const LOGIN_PATH = '/api/identity/auth/login';
const LOGOUT_PATH = '/api/identity/auth/logout';
const PUNCHES_PATH = '/api/attendance/punches';
const PUNCH_STATE_PATH = '/api/attendance/punches/state';

const EMPLOYEE_EMAIL = 'ada@company.com';
const EMPLOYEE_PASSWORD = 'EmployeeDemo!2026';
/** Account that does not exist; used to prove responses do not leak that. */
const UNKNOWN_EMAIL = 'nobody-here@company.com';
const WRONG_PASSWORD = 'definitely-not-the-password';

const COMPOSE_PROJECT = 'infra';
const DB_USER = 'wfh';
const DB_NAME = 'wfh_main';

/** Failure counter key shape used by the sign-in lockout. */
const lockoutKey = (email: string): string => `lockout:${email.trim().toLowerCase()}`;

const docker = (args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Id of the running container that backs one compose service. */
const containerId = (service: string): string => {
  const id = docker([
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
  ]);
  if (id === '') {
    throw new Error(
      `no running container for compose service "${service}" (project ${COMPOSE_PROJECT}); start the stack before running this suite`,
    );
  }
  return id.split('\n')[0];
};

/** Runs SQL in the main database and returns the trimmed, newline-joined rows. */
const psql = (sql: string): string =>
  docker([
    'exec',
    containerId('postgres-main'),
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    DB_USER,
    '-d',
    DB_NAME,
    '-t',
    '-A',
    '-c',
    sql,
  ]);

/** Deletes the lockout counter of one address so a run starts from zero. */
const clearLockout = (email: string): void => {
  docker(['exec', containerId('redis'), 'redis-cli', 'DEL', lockoutKey(email)]);
};

/**
 * Removes every punch row of the demo employee for the current working day.
 * The suite creates exactly those rows, so clearing them before and after a
 * run makes the file idempotent.
 */
const deleteDemoPunchRows = (): string =>
  psql(
    `WITH removed AS (
       DELETE FROM attendance_sessions
       WHERE employee_id = (SELECT id FROM employees WHERE email = '${EMPLOYEE_EMAIL}')
         AND work_date = (now() AT TIME ZONE 'Asia/Jakarta')::date
       RETURNING 1
     )
     SELECT count(*) FROM removed`,
  );

/** Number of punch rows carrying one of the given idempotency keys. */
const rowsForKeys = (keys: string[]): string => {
  const list = keys.map((key) => `'${key}'`).join(', ');
  return psql(
    `SELECT count(*) FROM attendance_sessions
     WHERE clock_in_key IN (${list}) OR clock_out_key IN (${list})`,
  );
};

const setCookieOf = (response: APIResponse): string => {
  const cookies = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);
  expect(
    cookies.length,
    'a successful sign-in must answer with a Set-Cookie header',
  ).toBeGreaterThan(0);
  return cookies.join('\n');
};

const sessionCookieValue = (setCookie: string): string => {
  const match = /(?:^|[,\s])sid=([^;\s]+)/.exec(setCookie);
  expect(match, 'the session cookie must be named sid').not.toBeNull();
  return match![1];
};

const uuid = (): string => crypto.randomUUID();

test.beforeAll(() => {
  clearLockout(EMPLOYEE_EMAIL);
  clearLockout(UNKNOWN_EMAIL);
  deleteDemoPunchRows();
});

test.afterAll(() => {
  clearLockout(EMPLOYEE_EMAIL);
  clearLockout(UNKNOWN_EMAIL);
  deleteDemoPunchRows();
});

test('sign-in succeeds and issues an HttpOnly session cookie that is replayed', async ({
  request,
}) => {
  const response = await request.post(LOGIN_PATH, {
    data: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_PASSWORD },
  });

  expect(response.status()).toBe(200);
  // The success body carries exactly the two advertised fields.
  expect(await response.json()).toEqual({
    role: 'employee',
    mustChangePassword: false,
  });

  const setCookie = setCookieOf(response);
  expect(setCookie).toContain('sid=');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('Path=/');
  // The edge here is plain HTTP, and the cookie is only marked Secure when the
  // request arrived over TLS; a Secure flag on http would make the cookie
  // unusable for the very next request.
  expect(setCookie).not.toMatch(/;\s*Secure/i);

  // The stored cookie must be attached to the next call without any help from
  // the caller: an authenticated read answers 200 ...
  const state = await request.get(PUNCH_STATE_PATH);
  expect(state.status()).toBe(200);

  // ... and the same cookie on a request that carries nothing else is what
  // authenticated it: dropping it turns the call into a 401.
  const bare = await request.get(PUNCH_STATE_PATH, {
    headers: { Cookie: '' },
  });
  expect(bare.status()).toBe(401);
});

test('unknown address and wrong password are indistinguishable', async ({
  request,
}) => {
  clearLockout(EMPLOYEE_EMAIL);
  clearLockout(UNKNOWN_EMAIL);

  const unknown = await request.post(LOGIN_PATH, {
    data: { email: UNKNOWN_EMAIL, password: WRONG_PASSWORD },
  });
  const wrongPassword = await request.post(LOGIN_PATH, {
    data: { email: EMPLOYEE_EMAIL, password: WRONG_PASSWORD },
  });

  expect(unknown.status()).toBe(401);
  expect(wrongPassword.status()).toBe(401);

  const unknownBody = await unknown.json();
  const wrongBody = await wrongPassword.json();

  // Same machine code and same human message for both, so the response cannot
  // be used to learn whether an address is registered.
  expect(unknownBody.code).toBe('AUTH_INVALID');
  expect(wrongBody.code).toBe('AUTH_INVALID');
  expect(unknownBody.statusCode).toBe(401);
  expect(wrongBody.statusCode).toBe(401);
  expect(unknownBody.message).toBe(wrongBody.message);

  // The attempts-left countdown behaves identically for both: this was the
  // first failure for each address.
  expect(unknownBody.attemptsRemaining).toBe(4);
  expect(wrongBody.attemptsRemaining).toBe(4);

  // Leave no counter behind for the tests that follow.
  clearLockout(EMPLOYEE_EMAIL);
  clearLockout(UNKNOWN_EMAIL);
});

test('five failures lock the account until the lockout key is removed', async ({
  request,
}) => {
  clearLockout(EMPLOYEE_EMAIL);

  const seen: number[] = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await request.post(LOGIN_PATH, {
      data: { email: EMPLOYEE_EMAIL, password: WRONG_PASSWORD },
    });
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.code).toBe('AUTH_INVALID');
    expect(body.attemptsRemaining).toBe(4 - attempt + 1);
    seen.push(body.attemptsRemaining);
  }
  expect(seen).toEqual([4, 3, 2, 1]);

  const fifth = await request.post(LOGIN_PATH, {
    data: { email: EMPLOYEE_EMAIL, password: WRONG_PASSWORD },
  });
  expect(fifth.status()).toBe(423);
  const fifthBody = await fifth.json();
  expect(fifthBody.code).toBe('AUTH_LOCKED');
  // The lock answer carries no attempts-left counter.
  expect(fifthBody).not.toHaveProperty('attemptsRemaining');

  // While the account is locked even the right password is refused.
  const whileLocked = await request.post(LOGIN_PATH, {
    data: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_PASSWORD },
  });
  expect(whileLocked.status()).toBe(423);
  expect((await whileLocked.json()).code).toBe('AUTH_LOCKED');

  // Unlocking is done by dropping the lockout key from Redis inside the
  // running container, which is what the 15 minute window would do by itself.
  clearLockout(EMPLOYEE_EMAIL);

  const afterUnlock = await request.post(LOGIN_PATH, {
    data: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_PASSWORD },
  });
  expect(afterUnlock.status()).toBe(200);
  expect(await afterUnlock.json()).toEqual({
    role: 'employee',
    mustChangePassword: false,
  });
});

test('a successful sign-in resets the failure counter', async ({ request }) => {
  clearLockout(EMPLOYEE_EMAIL);

  const firstFailure = await request.post(LOGIN_PATH, {
    data: { email: EMPLOYEE_EMAIL, password: WRONG_PASSWORD },
  });
  expect(firstFailure.status()).toBe(401);
  expect((await firstFailure.json()).attemptsRemaining).toBe(4);

  const success = await request.post(LOGIN_PATH, {
    data: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_PASSWORD },
  });
  expect(success.status()).toBe(200);

  // Had the counter survived the success, this would read 3 instead of 4.
  const afterSuccess = await request.post(LOGIN_PATH, {
    data: { email: EMPLOYEE_EMAIL, password: WRONG_PASSWORD },
  });
  expect(afterSuccess.status()).toBe(401);
  expect((await afterSuccess.json()).attemptsRemaining).toBe(4);

  clearLockout(EMPLOYEE_EMAIL);
});

test('logout answers 204 and a replayed cookie is refused', async ({
  request,
}) => {
  const login = await request.post(LOGIN_PATH, {
    data: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_PASSWORD },
  });
  expect(login.status()).toBe(200);
  const sid = sessionCookieValue(setCookieOf(login));

  // Control for the replay below: this worker starts every test with an empty
  // cookie jar, so the only way this call is authenticated is the Cookie
  // header carrying the captured value.
  const beforeLogout = await request.get(PUNCH_STATE_PATH, {
    headers: { Cookie: `sid=${sid}` },
  });
  expect(beforeLogout.status()).toBe(200);

  const logout = await request.post(LOGOUT_PATH, {
    headers: { Cookie: `sid=${sid}` },
  });
  expect(logout.status()).toBe(204);

  // The token is gone server-side, so the very same cookie is now worthless.
  const replay = await request.get(PUNCH_STATE_PATH, {
    headers: { Cookie: `sid=${sid}` },
  });
  expect(replay.status()).toBe(401);

  // Signing out without a live session is refused as well: this worker's jar
  // carries no cookie after the logout above.
  const anonymousLogout = await request.post(LOGOUT_PATH);
  expect(anonymousLogout.status()).toBe(401);
});

test('punch flow: idempotent masuk, one-open-session rule and pulang', async ({
  request,
}) => {
  // An anonymous caller reaches neither the state read nor a punch.
  const anonymousState = await request.get(PUNCH_STATE_PATH);
  expect(anonymousState.status()).toBe(401);
  const anonymousPunch = await request.post(PUNCHES_PATH, {
    headers: { 'Idempotency-Key': uuid() },
    data: { direction: 'masuk' },
  });
  expect(anonymousPunch.status()).toBe(401);

  const login = await request.post(LOGIN_PATH, {
    data: { email: EMPLOYEE_EMAIL, password: EMPLOYEE_PASSWORD },
  });
  expect(login.status()).toBe(200);

  const startState = await request.get(PUNCH_STATE_PATH);
  expect(startState.status()).toBe(200);
  const startBody = await startState.json();
  expect(startBody.status).toBe('belum_masuk');
  expect(startBody.clockInAt).toBeUndefined();

  const masukKey = uuid();
  const retryKey = masukKey;
  const otherMasukKey = uuid();
  const pulangKey = uuid();
  const secondPulangKey = uuid();

  const masuk = await request.post(PUNCHES_PATH, {
    headers: { 'Idempotency-Key': masukKey },
    data: { direction: 'masuk' },
  });
  expect(masuk.status()).toBe(200);
  const masukBody = await masuk.json();
  expect(masukBody.direction).toBe('masuk');
  expect(typeof masukBody.sessionId).toBe('string');
  expect(masukBody.sessionId.length).toBeGreaterThan(0);
  // The timestamp is assigned by the server clock, so it lands close to now.
  const masukAt = Date.parse(masukBody.at);
  expect(Number.isNaN(masukAt)).toBe(false);
  expect(Math.abs(masukAt - Date.now())).toBeLessThan(120_000);

  // Retrying with the same key replays the original answer instead of
  // writing a second row.
  const retry = await request.post(PUNCHES_PATH, {
    headers: { 'Idempotency-Key': retryKey },
    data: { direction: 'masuk' },
  });
  expect(retry.status()).toBe(200);
  expect(await retry.json()).toEqual(masukBody);
  expect(rowsForKeys([masukKey])).toBe('1');

  const workingState = await request.get(PUNCH_STATE_PATH);
  expect(workingState.status()).toBe(200);
  const workingBody = await workingState.json();
  expect(workingBody.status).toBe('bekerja');
  expect(workingBody.clockInAt).toBe(masukBody.at);

  // A second clock-in from "another tab" is refused and writes nothing.
  const clash = await request.post(PUNCHES_PATH, {
    headers: { 'Idempotency-Key': otherMasukKey },
    data: { direction: 'masuk' },
  });
  expect(clash.status()).toBe(409);
  expect((await clash.json()).code).toBe('SESSION_ALREADY_OPEN');
  expect(rowsForKeys([masukKey, otherMasukKey])).toBe('1');

  const pulang = await request.post(PUNCHES_PATH, {
    headers: { 'Idempotency-Key': pulangKey },
    data: { direction: 'pulang' },
  });
  expect(pulang.status()).toBe(200);
  const pulangBody = await pulang.json();
  expect(pulangBody.direction).toBe('pulang');
  expect(pulangBody.sessionId).toBe(masukBody.sessionId);

  const closedState = await request.get(PUNCH_STATE_PATH);
  expect(closedState.status()).toBe(200);
  const closedBody = await closedState.json();
  expect(closedBody.status).toBe('belum_masuk');
  expect(closedBody.clockInAt).toBeUndefined();
  expect(typeof closedBody.lastPunch).toBe('string');

  // Clocking out again with a fresh key has no open session to close.
  const secondPulang = await request.post(PUNCHES_PATH, {
    headers: { 'Idempotency-Key': secondPulangKey },
    data: { direction: 'pulang' },
  });
  expect(secondPulang.status()).toBe(409);
  expect((await secondPulang.json()).code).toBe('NO_OPEN_SESSION');
  expect(rowsForKeys([masukKey, otherMasukKey, pulangKey, secondPulangKey])).toBe('1');

  // The key that already produced a clock-in cannot be reused for the other
  // direction: same request identity, different command.
  const opposite = await request.post(PUNCHES_PATH, {
    headers: { 'Idempotency-Key': masukKey },
    data: { direction: 'pulang' },
  });
  expect(opposite.status()).toBe(422);
  expect((await opposite.json()).code).toBe('IDEMPOTENCY_CONFLICT');
  expect(rowsForKeys([masukKey, otherMasukKey, pulangKey, secondPulangKey])).toBe('1');
});
