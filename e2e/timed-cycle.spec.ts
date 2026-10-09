import { execFileSync } from 'node:child_process';

import argon2 from 'argon2';
import { expect, test } from '@playwright/test';

import {
  id as employeeDictionary,
  type DictKey as EmployeeDictKey,
} from '../../employee-web/src/i18n/id';

/**
 * One brand-new account through the whole opening sequence against the running
 * stack, against a stopwatch: press sign-in, clear the forced first-password
 * change, clock in, clock out — all of it inside a fixed wall-clock budget
 * that runs from the sign-in press to the assertion that the day is closed
 * again. The measured figure is printed so the run reports a number and not
 * just a pass.
 *
 * The account belongs to this run alone: its address carries a marker nothing
 * else uses, it is written straight into the main database with a temporary
 * password hashed by the very parameters the sign-in path verifies with, and
 * the flag that makes the forced change the only screen it can reach. Nothing
 * seeded is ever written and no global row count is ever asserted. Everything
 * the run creates is deleted from the database once it reports, and the
 * browser is left signed out.
 *
 * The employee screens carry no sign-out control of their own, so the run
 * signs out through the shared access-denied screen that both apps render for
 * a session that does not belong on them: opening the console with this
 * account is what puts that screen up, and its own button is what ends the
 * session.
 */

/** Compose project the stack runs under; used to reach its containers. */
const COMPOSE_PROJECT = 'infra';
const DB_USER = 'wfh';
const DB_NAME = 'wfh_main';

/** Password the fresh account opens with, straight out of the database. */
const TEMPORARY_PASSWORD = 'Timed-Cycle-Temp!2026';

/** Password the forced first change replaces it with, during this run. */
const CHOSEN_PASSWORD = 'Timed-Cycle-Chosen!2026';

/** Wall-clock allowance from the sign-in press to a closed day, in ms. */
const BUDGET_MS = 30_000;

/** Shape every id the identity service writes has. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Copy for one key of the dictionary the employee app renders from. */
const employeeCopy = (key: EmployeeDictKey): string => employeeDictionary[key];

/** Body shape one punch submission answers with. */
interface PunchAnswer {
  direction?: string;
  sessionId?: string;
  at?: string;
}

const docker = (args: string[]): string =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

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

/** Runs SQL in the main database and returns the trimmed answer. */
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

/** Address this run minted; the cleanup below keys on it alone. */
let provisionedEmail: string | null = null;

/**
 * Drops everything this run wrote, keyed to its own address. The two tables
 * pointing at an employee have to go first: both hold their foreign key with
 * a restrict rule, so the order below is what makes the delete legal.
 */
function removeProvisionedAccount(email: string): void {
  psql(
    `DELETE FROM profile_change_events
       WHERE employee_id IN (SELECT id FROM employees WHERE email = '${email}');
     DELETE FROM attendance_sessions
       WHERE employee_id IN (SELECT id FROM employees WHERE email = '${email}');
     DELETE FROM employees WHERE email = '${email}'`,
  );
}

test.afterAll(() => {
  if (provisionedEmail !== null) {
    removeProvisionedAccount(provisionedEmail);
  }
});

test('a fresh account signs in, changes its password and closes a day inside the budget', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);

  const email = `timed-cycle-${crypto.randomUUID().slice(0, 12)}@example.com`;
  provisionedEmail = email;

  // The row carries a temporary password and the flag that forces it to be
  // changed, so the sign-in below has nowhere to go but the change screen.
  // The hash is produced with the parameters the identity service itself
  // writes, which is what lets the ordinary verification path accept it.
  const passwordHash = await argon2.hash(TEMPORARY_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  // Wrapped in a select so the command answer is the id alone: a bare
  // `INSERT … RETURNING` appends its own command tag to the output.
  const employeeId = psql(
    `WITH created AS (
       INSERT INTO employees
         (name, email, position, phone, status, role, password_hash, must_change_password, auth_provider)
       VALUES
         ('Timed Cycle', '${email}', 'Timed Tester', '+62-816-0000-0000',
          'active', 'employee', '${passwordHash}', true, 'local')
       RETURNING id
     )
     SELECT id FROM created`,
  );
  expect(employeeId, 'the account must be written').toMatch(UUID_PATTERN);

  console.log(`[timed-cycle] ${email} | ${employeeId}`);

  // --- Sign-in ---------------------------------------------------------
  await page.goto('/');
  await expect(page.getByTestId('login')).toBeVisible();
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(TEMPORARY_PASSWORD);

  const signIn = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/api/identity/auth/login'),
  );
  const startedAt = Date.now();
  await page.getByTestId('login-submit').click();

  const signInResponse = await signIn;
  expect(signInResponse.status(), 'the temporary password must sign in').toBe(
    200,
  );
  expect(
    await signInResponse.json(),
    'the account still owes its first password change',
  ).toEqual({ role: 'employee', mustChangePassword: true });

  // --- The forced first change owns every address until it is saved ----
  await expect(page).toHaveURL(/\/first-login$/);
  await expect(page.getByTestId('first-login')).toBeVisible();
  await page.locator('#first-login-new-password').fill(CHOSEN_PASSWORD);
  await page.locator('#first-login-confirm-password').fill(CHOSEN_PASSWORD);
  await page.getByTestId('first-login-submit').click();
  await expect(page).toHaveURL(/\/absen$/);

  // --- Clock in --------------------------------------------------------
  const status = page.getByTestId('absen-status');
  await expect(status).toHaveText(employeeCopy('absen.status.belumMasuk'));
  await expect(page.getByTestId('punch-button')).toHaveText(
    employeeCopy('absen.punch.masuk'),
  );

  const clockedIn = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/attendance/punches'),
  );
  await page.getByTestId('punch-button').click();

  const clockedInResponse = await clockedIn;
  expect(clockedInResponse.status(), 'the clock-in must be recorded').toBe(200);
  const openAnswer = (await clockedInResponse.json()) as PunchAnswer;
  expect(openAnswer.direction).toBe('masuk');
  expect(
    openAnswer.sessionId,
    'the clock-in must name the session it opened',
  ).toMatch(UUID_PATTERN);

  // The recorded state, as the screen shows it: the day is running and the
  // primary action now offers the way out of it.
  await expect(status).toHaveText(employeeCopy('absen.status.bekerja'));
  await expect(page.getByTestId('absen-clock-in')).toBeVisible();
  await expect(page.getByTestId('punch-button')).toHaveText(
    employeeCopy('absen.punch.pulang'),
  );

  // --- Clock out -------------------------------------------------------
  const clockedOut = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/attendance/punches'),
  );
  await page.getByTestId('punch-button').click();

  const clockedOutResponse = await clockedOut;
  expect(clockedOutResponse.status(), 'the clock-out must be recorded').toBe(
    200,
  );
  const closedAnswer = (await clockedOutResponse.json()) as PunchAnswer;
  expect(closedAnswer.direction).toBe('pulang');
  expect(
    closedAnswer.sessionId,
    'the clock-out must close the very session the clock-in opened',
  ).toBe(openAnswer.sessionId);

  // The completed state: the day reads as not yet clocked in again, the
  // clock-in line is gone, the primary action offers a clock-in, and the
  // screen confirms the departure it just recorded.
  await expect(status).toHaveText(employeeCopy('absen.status.belumMasuk'));
  await expect(page.getByTestId('absen-clock-in')).toHaveCount(0);
  await expect(page.getByTestId('punch-button')).toHaveText(
    employeeCopy('absen.punch.masuk'),
  );
  await expect(page.getByTestId('success-toast')).toContainText(
    employeeCopy('absen.flash.pulang'),
  );

  // The stopwatch stops on the assertion above: sign-in press to a day the
  // screen says is closed.
  const elapsedMs = Date.now() - startedAt;
  testInfo.annotations.push({
    type: 'timed-cycle',
    description: `${elapsedMs} ms from sign-in press to a closed day (budget ${BUDGET_MS} ms)`,
  });
  console.log(
    `[timed-cycle] sign-in press → punch-out confirmed: ${elapsedMs} ms (budget ${BUDGET_MS} ms)`,
  );
  expect(
    elapsedMs,
    'the whole opening sequence must finish inside the budget',
  ).toBeLessThan(BUDGET_MS);

  // --- What the database kept, checked once the stopwatch is stopped ----
  expect(
    psql(
      `SELECT count(*) FROM attendance_sessions WHERE employee_id = '${employeeId}'`,
    ),
    'one clock-in and one clock-out leave exactly one session row',
  ).toBe('1');
  expect(
    psql(
      `SELECT count(*) FROM attendance_sessions
        WHERE employee_id = '${employeeId}'
          AND work_date = (now() AT TIME ZONE 'Asia/Jakarta')::date
          AND clock_in_at IS NOT NULL
          AND clock_out_at IS NOT NULL
          AND closed_by_system = false`,
    ),
    'the row carries both clocks and was closed by the employee',
  ).toBe('1');

  // --- Sign out through the one control both apps share ----------------
  // The employee screens offer no sign-out of their own, so the account is
  // opened on the console — where a session of this role is denied every
  // address — and the sign-out on that screen is pressed.
  await page.goto('/hrd/');
  await expect(page.getByTestId('access-denied-state')).toBeVisible();
  await page.getByTestId('sign-out-button').click();
  await expect(page).toHaveURL(/\/hrd\/login$/);

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('login')).toBeVisible();

  // The rows go now, so a repeat run starts from the same clean database.
  removeProvisionedAccount(email);
  provisionedEmail = null;
  expect(
    psql(`SELECT count(*) FROM employees WHERE email = '${email}'`),
    'the fixture account is gone',
  ).toBe('0');
});
