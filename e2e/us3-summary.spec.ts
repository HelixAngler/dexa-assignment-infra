import { execFileSync } from 'node:child_process';

import argon2 from 'argon2';
import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  id as indonesianDictionary,
  type DictKey,
} from '../../employee-web/src/i18n/id';

/**
 * Attendance-summary journey against the running stack.
 *
 * The account belongs to this run and to no one else: a unique address, a
 * password hashed with the same argon2id parameters the identity service
 * writes, and exactly two attendance sessions inserted straight into the main
 * database so the clock times on screen are fixed and known in advance. No
 * seeded account is read or written, no global row count is ever asserted,
 * and every row the journey creates is deleted again afterwards.
 *
 * The identity service exposes no employee-creation route, so writing the row
 * is the only way to bring a brand-new employee into the stack; everything a
 * person would actually do — sign in, clear the forced first password change,
 * read the summary — then happens through the real screens and the real API.
 *
 * The screen itself is checked in the four states it has to handle: the range
 * it opens with before anybody touches the filter, an exact From–To pair
 * whose times must match the stored rows, a window with no sessions at all,
 * and a From date after the To date, which the screen has to refuse before it
 * puts anything on the wire.
 */

/** Compose project the stack runs under; used to reach its containers. */
const COMPOSE_PROJECT = 'infra';
const DB_USER = 'wfh';
const DB_NAME = 'wfh_main';

/**
 * The one zone this product measures days and clocks in. The browser is
 * pinned to it as well, so "today" on the screen, "today" on the server and
 * the rendered clock times all agree no matter where the machine running the
 * journey happens to be.
 */
const COMPANY_TIME_ZONE = 'Asia/Jakarta';

/** Whole-hour offset of that zone; it observes no daylight saving. */
const COMPANY_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Password the fresh account carries until the forced change replaces it. */
const FIRST_PASSWORD = 'Summary-First!2026';

/** Password the journey leaves behind so the account signs in normally after. */
const CHOSEN_PASSWORD = 'Summary-Chosen!2026';

/**
 * Punch instants written as UTC, a few hours into their own company day so
 * the rendered clock times sit far away from any day boundary.
 */
const YESTERDAY_CLOCK_IN_UTC = 'T01:15:00.000Z';
const YESTERDAY_CLOCK_OUT_UTC = 'T10:45:00.000Z';
const TODAY_CLOCK_IN_UTC = 'T00:45:00.000Z';

/** Copy for one key of the Indonesian dictionary the screens render from. */
const copy = (key: DictKey): string => indonesianDictionary[key];

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

/** The company calendar day an instant falls on, as `YYYY-MM-DD`. */
function companyDayKey(instant: Date): string {
  return new Date(instant.getTime() + COMPANY_UTC_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Clock text exactly as the summary table renders it: an ISO instant cut down
 * to hours and minutes in the zone the screen is pinned to. The component
 * builds its string the same way, so an expected value cannot drift from what
 * the browser prints.
 */
function renderedClock(isoInstant: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: COMPANY_TIME_ZONE,
  }).format(new Date(isoInstant));
}

/**
 * One summary date, whichever layout the viewport is showing: a wide screen
 * gets a table row, a narrow one a stacked card, and only one of the two is
 * ever on screen.
 */
function visibleRowOn(page: Page, date: string): Locator {
  return page.locator(
    `[data-testid="summary-row"][data-date="${date}"]:visible, [data-testid="summary-card"][data-date="${date}"]:visible`,
  );
}

/** Every summary date currently on screen, in the order they are listed. */
function visibleRows(page: Page): Locator {
  return page.locator(
    '[data-testid="summary-row"]:visible, [data-testid="summary-card"]:visible',
  );
}

/** Address of the account this run provisions; the cleanup below keys on it. */
let provisionedEmail: string | null = null;

/**
 * Removes the rows this run created, keyed to its own address alone. The two
 * tables that point at an employee have to go first: both hold their foreign
 * key with a restrict rule, so the order below is what makes the delete legal.
 */
function removeProvisionedEmployee(email: string): void {
  psql(
    `DELETE FROM profile_change_events
       WHERE employee_id IN (SELECT id FROM employees WHERE email = '${email}');
     DELETE FROM attendance_sessions
       WHERE employee_id IN (SELECT id FROM employees WHERE email = '${email}');
     DELETE FROM employees WHERE email = '${email}'`,
  );
}

// Pinning the browser to the company zone keeps the calendar the screen
// computes, the calendar the server computes and the clock text it prints in
// agreement with the days written into the database above.
test.use({ timezoneId: COMPANY_TIME_ZONE });

test.afterAll(() => {
  if (provisionedEmail !== null) {
    removeProvisionedEmployee(provisionedEmail);
  }
});

test('the summary opens on its default range and answers an exact, an empty and a refused range', async ({ page }) => {
  test.setTimeout(180_000);

  const now = new Date();
  const today = companyDayKey(now);
  const yesterday = companyDayKey(new Date(now.getTime() - 86_400_000));
  const monthStart = `${today.slice(0, 8)}01`;

  const yesterdayIn = `${yesterday}${YESTERDAY_CLOCK_IN_UTC}`;
  const yesterdayOut = `${yesterday}${YESTERDAY_CLOCK_OUT_UTC}`;
  const todayIn = `${today}${TODAY_CLOCK_IN_UTC}`;

  const email = `us3-summary-${crypto.randomUUID().slice(0, 12)}@example.com`;
  provisionedEmail = email;

  // The employee row carries a temporary password and the flag that forces it
  // to be changed, so the sign-in below has to go through the real change
  // screen before the app will let the account anywhere else. The hash is
  // produced with the parameters the identity service itself writes, which is
  // what lets the ordinary verification path accept it unchanged.
  const passwordHash = await argon2.hash(FIRST_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const employeeId = psql(
    `WITH created AS (
       INSERT INTO employees
         (name, email, position, phone, status, role, password_hash, must_change_password, auth_provider)
       VALUES
         ('Summary Journey', '${email}', 'Summary Tester', '+62-819-0000-0000',
          'active', 'employee', '${passwordHash}', true, 'local')
       RETURNING id
     )
     SELECT id FROM created`,
  );
  expect(employeeId, 'the account must be written').toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

  // Exactly two sessions: yesterday closed by the employee's own clock-out,
  // today still open. Every column that decides how a row renders is supplied
  // here rather than left to a default, so the screen has one right answer.
  const insertedSessions = psql(
    `WITH created AS (
       INSERT INTO attendance_sessions
         (employee_id, work_date, clock_in_at, clock_out_at,
          clock_in_key, clock_out_key, closed_by_system)
       VALUES
         ('${employeeId}', DATE '${yesterday}',
          TIMESTAMPTZ '${yesterdayIn}', TIMESTAMPTZ '${yesterdayOut}',
          gen_random_uuid(), gen_random_uuid(), false),
         ('${employeeId}', DATE '${today}',
          TIMESTAMPTZ '${todayIn}', NULL,
          gen_random_uuid(), NULL, false)
       RETURNING id
     )
     SELECT count(*) FROM created`,
  );
  expect(insertedSessions, 'both sessions must be written').toBe('2');

  console.log(
    `[summary-journey] ${email} | ${yesterday} ${renderedClock(yesterdayIn)}–${renderedClock(yesterdayOut)} | ${today} ${renderedClock(todayIn)} (open)`,
  );

  // The employee signs in through the real sign-in screen of their app.
  await page.goto('/');
  await expect(page.getByTestId('login')).toBeVisible();
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(FIRST_PASSWORD);
  await page.getByTestId('login-submit').click();

  // A temporary password owns every address until it is replaced, so the
  // sign-in has nowhere to go but the change screen.
  await expect(page).toHaveURL(/\/first-login$/);
  await expect(page.getByTestId('first-login')).toBeVisible();
  await page.locator('#first-login-new-password').fill(CHOSEN_PASSWORD);
  await page.locator('#first-login-confirm-password').fill(CHOSEN_PASSWORD);
  await page.getByTestId('first-login-submit').click();
  await expect(page).toHaveURL(/\/absen$/);

  // 1. The range the screen opens with, before anybody touches the filter:
  //    first of this month through today, asked for with no bounds at all.
  const defaultLoad = page.waitForResponse((response) =>
    response.url().includes('/api/attendance/summary'),
  );
  await page.goto('/summary');
  const defaultResponse = await defaultLoad;
  expect(defaultResponse.status()).toBe(200);
  expect(
    new URL(defaultResponse.url()).search,
    'the opening view must ask for no bounds',
  ).toBe('');

  await expect(page.getByTestId('summary')).toBeVisible();
  await expect(page.locator('#summary-range-from')).toHaveValue(monthStart);
  await expect(page.locator('#summary-range-to')).toHaveValue(today);

  const openDayRow = visibleRowOn(page, today);
  await expect(openDayRow, "today's row is on screen").toHaveCount(1);
  await expect(
    openDayRow.getByTestId('summary-masuk'),
    "today's clock-in is the stored one",
  ).toHaveText(renderedClock(todayIn));
  await expect(
    openDayRow.getByTestId('summary-still-working'),
    'an unclosed session says it is still working',
  ).toHaveText(copy('summary.row.stillWorking'));

  // Yesterday only sits inside the opening window once today has moved past
  // the first of the month; on the first it belongs to the previous month and
  // the default range cannot reach it, in which case the exact-range step
  // below is where both dates are pinned down together.
  if (yesterday.slice(0, 7) === today.slice(0, 7)) {
    const closedDayRow = visibleRowOn(page, yesterday);
    await expect(closedDayRow, "yesterday's row is on screen").toHaveCount(1);
    await expect(
      closedDayRow.getByTestId('summary-masuk'),
      "yesterday's clock-in is the stored one",
    ).toHaveText(renderedClock(yesterdayIn));
    await expect(
      closedDayRow.getByTestId('summary-pulang'),
      "yesterday's clock-out is the stored one",
    ).toHaveText(renderedClock(yesterdayOut));
    await expect(
      closedDayRow.locator('[data-testid="summary-still-working"]'),
      'a closed session is not working any more',
    ).toHaveCount(0);
    await expect(
      closedDayRow.locator('[data-testid="summary-system-closed"]'),
      'an ordinary clock-out is not a system closure',
    ).toHaveCount(0);
  }

  // 2. An exact two-day range: the pair comes back in date order carrying the
  //    times that were written into the database.
  await page.locator('#summary-range-from').fill(yesterday);
  await page.locator('#summary-range-to').fill(today);

  const filteredLoad = page.waitForResponse((response) =>
    response.url().includes('/api/attendance/summary'),
  );
  await page.getByTestId('summary-search').click();
  const filteredResponse = await filteredLoad;
  expect(new URL(filteredResponse.url()).search).toBe(
    `?from=${yesterday}&to=${today}`,
  );
  expect(await filteredResponse.json()).toEqual({
    rows: [
      {
        date: yesterday,
        masuk: yesterdayIn,
        pulang: yesterdayOut,
        open: false,
        systemClosed: false,
      },
      {
        date: today,
        masuk: todayIn,
        pulang: null,
        open: true,
        systemClosed: false,
      },
    ],
  });

  const filteredRows = visibleRows(page);
  await expect(filteredRows, 'exactly the two requested days').toHaveCount(2);
  await expect(filteredRows.nth(0)).toHaveAttribute('data-date', yesterday);
  await expect(filteredRows.nth(1)).toHaveAttribute('data-date', today);

  const closedRow = filteredRows.nth(0);
  await expect(closedRow.getByTestId('summary-masuk')).toHaveText(
    renderedClock(yesterdayIn),
  );
  await expect(closedRow.getByTestId('summary-pulang')).toHaveText(
    renderedClock(yesterdayOut),
  );
  await expect(
    closedRow.locator('[data-testid="summary-still-working"]'),
  ).toHaveCount(0);
  await expect(
    closedRow.locator('[data-testid="summary-system-closed"]'),
  ).toHaveCount(0);

  const stillOpenRow = filteredRows.nth(1);
  await expect(stillOpenRow.getByTestId('summary-masuk')).toHaveText(
    renderedClock(todayIn),
  );
  await expect(stillOpenRow.getByTestId('summary-still-working')).toHaveText(
    copy('summary.row.stillWorking'),
  );

  // 3. A window with no sessions in it at all: the screen explains the empty
  //    result instead of showing a grid with nothing in it.
  await page.locator('#summary-range-from').fill('2020-01-01');
  await page.locator('#summary-range-to').fill('2020-01-31');

  const emptyLoad = page.waitForResponse((response) =>
    response.url().includes('/api/attendance/summary'),
  );
  await page.getByTestId('summary-search').click();
  const emptyResponse = await emptyLoad;
  expect(new URL(emptyResponse.url()).search).toBe(
    '?from=2020-01-01&to=2020-01-31',
  );
  expect(await emptyResponse.json()).toEqual({ rows: [] });

  const emptyState = page.getByTestId('empty-state');
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toContainText(copy('summary.empty.title'));
  await expect(emptyState).toContainText(copy('summary.empty.description'));
  await expect(
    page.locator('[data-testid="summary-row"], [data-testid="summary-card"]'),
    'no date rows are listed for an empty range',
  ).toHaveCount(0);

  // 4. A From date after the To date is a contradiction the screen catches by
  //    itself: the reason is announced, the button stops being pressable, and
  //    the server is never asked.
  await page.locator('#summary-range-from').fill('2020-02-01');
  await page.locator('#summary-range-to').fill('2020-01-31');

  const refusal = page.getByTestId('summary-range-error');
  await expect(refusal).toBeVisible();
  await expect(refusal).toHaveAttribute('role', 'alert');
  await expect(refusal).toHaveText(copy('summary.filter.rangeInvalid'));
  await expect(page.getByTestId('summary-search')).toBeDisabled();
  await expect(page.locator('#summary-range-from')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.locator('#summary-range-to')).toHaveAttribute(
    'aria-invalid',
    'true',
  );

  // Pressing it anyway must leave the network alone. The probe is armed
  // before the click and gives up quickly, so a request that does happen is
  // reported as a failure rather than silently missed.
  const strayRequest = page
    .waitForRequest(
      (request) => request.url().includes('/api/attendance/summary'),
      { timeout: 750 },
    )
    .then(() => true)
    .catch(() => false);
  await page.getByTestId('summary-search').click({ force: true });
  expect(
    await strayRequest,
    'a refused range must not reach the server',
  ).toBe(false);
});
