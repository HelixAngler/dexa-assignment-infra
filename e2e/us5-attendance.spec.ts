import { execFileSync } from 'node:child_process';

import argon2 from 'argon2';
import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  id as hrdDictionary,
  type DictKey as HrdDictKey,
} from '../../hrd-web/src/i18n/id';

/**
 * The HRD day view driven through the console itself against the running
 * stack: sign in, open the Absensi menu, read one day, change the day, search
 * a name, and prove that the screen cannot write anything.
 *
 * Three employees belong to this run and to nobody else: one random marker
 * sits in every name and every address, and the three of them cover the
 * shapes the view has to render — a finished day with both clocks known, a
 * day still running, and a person who punched nothing at all. The first one
 * also owns a closed day behind it, so changing the date has something to
 * prove. The rows are written straight into the main database with fixed
 * instants, so the clock text on screen is known before the browser opens;
 * nothing seeded is ever written, no global row count is ever asserted, and
 * every row this run creates is deleted again before the run reports.
 *
 * Two independent proofs carry the read-only claim: the rendered result
 * region holds no button, no field, no choice and no link at all, and a guard
 * over every request the page makes fails the run the moment a verb other
 * than a read leaves the browser. A last request-level probe asks the very
 * same address for each writing verb and is turned away.
 */

/** Compose project the stack runs under; used to reach its containers. */
const COMPOSE_PROJECT = 'infra';
const DB_USER = 'wfh';
const DB_NAME = 'wfh_main';

/** The console's administrator account; it is only ever signed in and out. */
const HRD_EMAIL = 'ivan@company.com';
const HRD_PASSWORD = 'HrdAdmin!2026';

/**
 * The one zone this product measures days and clocks in. The browser is
 * pinned to it as well, so "today" on the screen, "today" in the database and
 * the rendered clock times all agree no matter where the machine running the
 * journey happens to be.
 */
const COMPANY_TIME_ZONE = 'Asia/Jakarta';

/** Whole-hour offset of that zone; it observes no daylight saving. */
const COMPANY_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Password material the fixture rows carry. These accounts are only ever
 * read from the day view and never sign in, but the hash and the flags are
 * written the way the sign-in path expects them so the rows stay ordinary
 * ones.
 */
const FIXTURE_PASSWORD = 'Attendance-Fixture!2026';

/** Fixed punch instants, written as UTC a few hours into their own day. */
const TODAY_CLOCK_IN_UTC = 'T00:45:00.000Z';
const TODAY_CLOCK_OUT_UTC = 'T10:15:00.000Z';
const TODAY_OPEN_CLOCK_IN_UTC = 'T01:30:00.000Z';
const YESTERDAY_CLOCK_IN_UTC = 'T01:15:00.000Z';
const YESTERDAY_CLOCK_OUT_UTC = 'T10:45:00.000Z';

/** Addresses the journey legitimately posts to: nothing else may write. */
const WRITES_ALLOWED: RegExp[] = [
  /\/api\/identity\/auth\/login$/,
  /\/api\/identity\/auth\/logout$/,
  // The shell mints a token for its realtime channel; it carries no data.
  /\/api\/notification\/realtime\/auth$/,
];

/** Copy for one key of the dictionary the console renders from. */
const hrdCopy = (key: HrdDictKey): string => hrdDictionary[key];

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
 * Clock text exactly as a day-view cell renders it: an ISO instant cut down
 * to hours and minutes, in the locale the console opens with and the zone the
 * browser is pinned to. The cell builds its string the same way, so an
 * expected value cannot drift from what the page prints.
 */
function renderedClock(isoInstant: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: COMPANY_TIME_ZONE,
  }).format(new Date(isoInstant));
}

/**
 * One employee's line for the queried day, whichever layout the viewport is
 * showing: a wide screen gets a table row, a narrow one a stacked card, and
 * only one of the two is ever on screen.
 */
function attendanceRowOn(page: Page, name: string): Locator {
  return page
    .locator(
      '[data-testid="attendance-row"]:visible, [data-testid="attendance-card"]:visible',
    )
    .filter({ hasText: name });
}

/** Markers every fixture row of this run carries; the cleanup keys on them. */
const provisionedMarkers: string[] = [];

/**
 * Drops the people one marker names and everything they punched. The rows
 * were written straight into the database, so the database is also where they
 * go: the sessions first, because the people row holds their key back.
 */
function removeFixtures(marker: string): void {
  psql(
    `DELETE FROM attendance_sessions
       WHERE employee_id IN (SELECT id FROM employees WHERE email LIKE '${marker}%');
     DELETE FROM employees WHERE email LIKE '${marker}%'`,
  );
}

// Pinning the browser to the company zone keeps the calendar the screen
// computes and the calendar written into the database above on the same day.
test.use({ timezoneId: COMPANY_TIME_ZONE });

test.afterAll(() => {
  for (const marker of provisionedMarkers) {
    removeFixtures(marker);
  }
});

test('the day view lists everybody for a date and offers nothing to change', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);

  const baseURL = testInfo.project.use.baseURL ?? 'http://localhost:8080';

  const now = new Date();
  const today = companyDayKey(now);
  const yesterday = companyDayKey(new Date(now.getTime() - 86_400_000));

  const marker = `us5-att-${crypto.randomUUID()}`;
  provisionedMarkers.push(marker);

  const names = {
    a: `Us5Att ${marker} A`,
    b: `Us5Att ${marker} B`,
    c: `Us5Att ${marker} C`,
  };
  const emails = {
    a: `${marker}-a@example.com`,
    b: `${marker}-b@example.com`,
    c: `${marker}-c@example.com`,
  };
  /** A term that names one of the three and nobody else in the database. */
  const termForA = `${marker} A`;

  const todayIn = `${today}${TODAY_CLOCK_IN_UTC}`;
  const todayOut = `${today}${TODAY_CLOCK_OUT_UTC}`;
  const todayOpenIn = `${today}${TODAY_OPEN_CLOCK_IN_UTC}`;
  const yesterdayIn = `${yesterday}${YESTERDAY_CLOCK_IN_UTC}`;
  const yesterdayOut = `${yesterday}${YESTERDAY_CLOCK_OUT_UTC}`;

  /** Ids of the three fixtures, kept so their sessions can be counted later. */
  const employeeIds: string[] = [];
  /** Everything the page asked for that was not a read. */
  const violations: string[] = [];
  /** Non-reads the guard waved through; proves the guard was awake. */
  const permittedWrites: string[] = [];

  let failure: unknown = null;

  try {
    // The guard sits over the whole journey, so it sees the very first
    // navigation onwards. Anything that is not a read is stopped on the way
    // out and written down; the run is judged on that list when it finishes.
    await page.route('**/*', async (route) => {
      const request = route.request();
      const method = request.method();
      const isRead =
        method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
      try {
        if (isRead) {
          await route.continue();
          return;
        }
        if (WRITES_ALLOWED.some((allowed) => allowed.test(request.url()))) {
          permittedWrites.push(`${method} ${request.url()}`);
          await route.continue();
          return;
        }
        violations.push(`${method} ${request.url()}`);
        await route.abort();
      } catch {
        // The page may already have moved on; nothing left to hand over.
      }
    });

    // --- The fixture people, written straight into the main database -----
    // The sign-in path hashes with these very parameters, so the rows are
    // ordinary ones even though nobody ever signs in with them.
    const passwordHash = await argon2.hash(FIXTURE_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const written = psql(
      `WITH created AS (
         INSERT INTO employees
           (name, email, position, phone, status, role,
            password_hash, must_change_password, auth_provider)
         VALUES
           ('${names.a}', '${emails.a}', 'Attendance Fixture', '+62-813-0000-0101',
            'active', 'employee', '${passwordHash}', false, 'local'),
           ('${names.b}', '${emails.b}', 'Attendance Fixture', '+62-813-0000-0102',
            'active', 'employee', '${passwordHash}', false, 'local'),
           ('${names.c}', '${emails.c}', 'Attendance Fixture', '+62-813-0000-0103',
            'active', 'employee', '${passwordHash}', false, 'local')
         RETURNING id, email
       )
       SELECT email || '|' || id FROM created ORDER BY email`,
    )
      .split('\n')
      .filter((line) => line !== '');

    expect(written, 'the three fixture people must be written').toHaveLength(3);
    expect(written[0].split('|')[0]).toBe(emails.a);
    expect(written[1].split('|')[0]).toBe(emails.b);
    expect(written[2].split('|')[0]).toBe(emails.c);
    employeeIds.push(...written.map((line) => line.split('|')[1]));
    const [idA, idB, idC] = employeeIds;

    // Three sessions: the first person's finished day today and the day
    // behind it, the second person's day still running, and nothing at all
    // for the third. Every column that decides how a line renders is written
    // here rather than left to a default, so each row has one right answer.
    const insertedSessions = psql(
      `WITH created AS (
         INSERT INTO attendance_sessions
           (employee_id, work_date, clock_in_at, clock_out_at,
            clock_in_key, clock_out_key, closed_by_system)
         VALUES
           ('${idA}', DATE '${today}',
            TIMESTAMPTZ '${todayIn}', TIMESTAMPTZ '${todayOut}',
            gen_random_uuid(), gen_random_uuid(), false),
           ('${idA}', DATE '${yesterday}',
            TIMESTAMPTZ '${yesterdayIn}', TIMESTAMPTZ '${yesterdayOut}',
            gen_random_uuid(), gen_random_uuid(), false),
           ('${idB}', DATE '${today}',
            TIMESTAMPTZ '${todayOpenIn}', NULL,
            gen_random_uuid(), NULL, false)
         RETURNING id
       )
       SELECT count(*) FROM created`,
    );
    expect(insertedSessions, 'the three fixture sessions must be written').toBe(
      '3',
    );

    console.log(
      `[read-only-attendance] ${marker} | ${today} ${renderedClock(todayIn)}–${renderedClock(todayOut)} / open ${renderedClock(todayOpenIn)} | ${yesterday} ${renderedClock(yesterdayIn)}–${renderedClock(yesterdayOut)}`,
    );

    // --- The console, entered through its own sign-in screen -------------
    // The bare prefix answers with a directory redirect, so the journey
    // opens the mounted address itself.
    await page.goto('/hrd/');
    await expect(page).toHaveURL(/\/hrd\/login$/);
    await expect(page.getByTestId('login')).toBeVisible();
    await expect(page.getByTestId('shell-sign-out')).toHaveCount(0);

    const signedIn = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/identity/auth/login'),
    );
    await page.locator('#login-email').fill(HRD_EMAIL);
    await page.locator('#login-password').fill(HRD_PASSWORD);
    await page.getByTestId('login-submit').click();

    const signInResponse = await signedIn;
    expect(signInResponse.status(), 'the administrator must sign in').toBe(200);
    expect(await signInResponse.json()).toEqual({
      role: 'hrd',
      mustChangePassword: false,
    });
    await expect(page).toHaveURL(/\/hrd\/karyawan$/);
    await expect(page.getByTestId('karyawan-list')).toBeVisible();
    await expect(page.getByTestId('shell-sign-out')).toBeVisible();

    // --- The Absensi menu -------------------------------------------------
    const defaultLoad = page.waitForResponse((response) =>
      response.url().includes('/api/attendance/attendance'),
    );
    const wideMenuLink = page.locator(
      '[data-testid="nav-desktop"] a[href="/hrd/absensi"]',
    );
    if (await wideMenuLink.isVisible()) {
      await wideMenuLink.click();
    } else {
      // A narrow screen keeps the menu behind its own toggle.
      await page.getByTestId('nav-toggle').click();
      await page
        .locator('[data-testid="nav-mobile"] a[href="/hrd/absensi"]')
        .click();
    }
    await expect(page).toHaveURL(/\/hrd\/absensi$/);

    const defaultResponse = await defaultLoad;
    expect(defaultResponse.status(), 'the day view must answer').toBe(200);
    expect(
      new URL(defaultResponse.url()).search,
      'the opening view asks for today and nothing else',
    ).toBe(`?date=${today}`);

    await expect(page.getByTestId('absensi')).toBeVisible();
    await expect(page.getByTestId('absensi-date')).toHaveValue(today);

    // --- Today: all three people, each in its own shape ------------------
    const rowA = attendanceRowOn(page, names.a);
    const rowB = attendanceRowOn(page, names.b);
    const rowC = attendanceRowOn(page, names.c);

    await expect(rowA, 'the finished day is listed').toHaveCount(1);
    await expect(rowA).toHaveAttribute('data-employee-id', idA);
    await expect(rowA).toHaveAttribute('data-state', 'done');
    await expect(rowA.getByTestId('attendance-masuk')).toHaveText(
      renderedClock(todayIn),
    );
    await expect(rowA.getByTestId('attendance-pulang')).toHaveText(
      renderedClock(todayOut),
    );
    await expect(rowA.getByTestId('attendance-status')).toHaveAttribute(
      'data-state',
      'done',
    );
    await expect(rowA.getByTestId('attendance-status')).toHaveText(
      hrdCopy('absensi.row.status.done'),
    );

    await expect(rowB, 'the running day is listed').toHaveCount(1);
    await expect(rowB).toHaveAttribute('data-employee-id', idB);
    await expect(rowB).toHaveAttribute('data-state', 'open');
    await expect(rowB.getByTestId('attendance-masuk')).toHaveText(
      renderedClock(todayOpenIn),
    );
    // The departure cell carries the still-running wording and no clock of
    // its own: nothing has been written down for it yet.
    await expect(rowB.getByTestId('attendance-pulang')).toHaveText(
      hrdCopy('absensi.row.stillWorking'),
    );
    await expect(rowB.getByTestId('attendance-status')).toHaveAttribute(
      'data-state',
      'open',
    );
    await expect(rowB.getByTestId('attendance-status')).toHaveText(
      hrdCopy('absensi.row.status.open'),
    );

    await expect(rowC, 'the person with no punch is listed').toHaveCount(1);
    await expect(rowC).toHaveAttribute('data-employee-id', idC);
    await expect(rowC).toHaveAttribute('data-state', '-');
    await expect(rowC.getByTestId('attendance-masuk')).toHaveText('-');
    await expect(rowC.getByTestId('attendance-pulang')).toHaveText('-');
    await expect(rowC.getByTestId('attendance-status')).toHaveAttribute(
      'data-state',
      '-',
    );
    await expect(rowC.getByTestId('attendance-status')).toHaveText(
      hrdCopy('absensi.row.status.noPunch'),
    );

    // --- The day behind today --------------------------------------------
    const yesterdayLoad = page.waitForResponse((response) =>
      response.url().includes('/api/attendance/attendance'),
    );
    await page.getByTestId('absensi-date').fill(yesterday);

    const yesterdayResponse = await yesterdayLoad;
    expect(new URL(yesterdayResponse.url()).search).toBe(
      `?date=${yesterday}`,
    );
    await expect(page.getByTestId('absensi-date')).toHaveValue(yesterday);

    await expect(rowA, 'the day behind still lists the first person').toHaveCount(
      1,
    );
    await expect(rowA).toHaveAttribute('data-state', 'done');
    await expect(rowA.getByTestId('attendance-masuk')).toHaveText(
      renderedClock(yesterdayIn),
    );
    await expect(rowA.getByTestId('attendance-pulang')).toHaveText(
      renderedClock(yesterdayOut),
    );

    await expect(
      rowB,
      'the other two punched nothing on that day',
    ).toHaveCount(1);
    await expect(rowB).toHaveAttribute('data-state', '-');
    await expect(rowB.getByTestId('attendance-masuk')).toHaveText('-');
    await expect(rowB.getByTestId('attendance-pulang')).toHaveText('-');
    await expect(rowC).toHaveCount(1);
    await expect(rowC).toHaveAttribute('data-state', '-');
    await expect(rowC.getByTestId('attendance-masuk')).toHaveText('-');
    await expect(rowC.getByTestId('attendance-pulang')).toHaveText('-');

    // --- Back to today ----------------------------------------------------
    const backLoad = page.waitForResponse((response) =>
      response.url().includes('/api/attendance/attendance'),
    );
    await page.getByTestId('absensi-date').fill(today);

    const backResponse = await backLoad;
    expect(new URL(backResponse.url()).search).toBe(`?date=${today}`);
    await expect(page.getByTestId('absensi-date')).toHaveValue(today);
    await expect(rowA.getByTestId('attendance-masuk')).toHaveText(
      renderedClock(todayIn),
    );
    await expect(rowB).toHaveAttribute('data-state', 'open');
    await expect(rowB.getByTestId('attendance-pulang')).toHaveText(
      hrdCopy('absensi.row.stillWorking'),
    );
    await expect(rowC.getByTestId('attendance-pulang')).toHaveText('-');

    // --- A name that belongs to one person alone -------------------------
    const searchLoad = page.waitForResponse((response) =>
      response.url().includes('/api/attendance/attendance'),
    );
    await page.getByTestId('absensi-search').fill(termForA);
    await page.getByTestId('absensi-search-submit').click();

    const searchResponse = await searchLoad;
    const searchUrl = new URL(searchResponse.url());
    expect(searchUrl.searchParams.get('date')).toBe(today);
    expect(searchUrl.searchParams.get('q')).toBe(termForA);
    const searchBody = (await searchResponse.json()) as {
      rows: { name: string }[];
    };
    expect(searchBody.rows, 'the term names one person').toHaveLength(1);
    expect(searchBody.rows[0].name).toBe(names.a);

    await expect(rowA).toHaveCount(1);
    await expect(rowB, 'the term belongs to nobody else').toHaveCount(0);
    await expect(rowC, 'the term belongs to nobody else').toHaveCount(0);

    const clearedLoad = page.waitForResponse((response) =>
      response.url().includes('/api/attendance/attendance'),
    );
    await page.getByTestId('absensi-search').fill('');
    await page.getByTestId('absensi-search-submit').click();

    const clearedResponse = await clearedLoad;
    const clearedUrl = new URL(clearedResponse.url());
    expect(clearedUrl.search, 'an empty term is no term at all').toBe(
      `?date=${today}`,
    );
    expect(clearedUrl.searchParams.get('q')).toBeNull();
    await expect(rowA, 'clearing the term brings everybody back').toHaveCount(
      1,
    );
    await expect(rowB).toHaveCount(1);
    await expect(rowC).toHaveCount(1);

    // --- Read-only, layer one: the document itself -----------------------
    // The banner over the view says so out loud, and the region that holds
    // the answers — both the wide table and the narrow cards, whichever the
    // viewport is showing — is checked for any control at all. The date and
    // name fields above that region belong to the filter and are not part of
    // what they filter.
    await expect(page.getByTestId('absensi-readonly')).toBeVisible();
    await expect(page.getByTestId('absensi-readonly')).toHaveText(
      hrdCopy('absensi.readOnlyNote'),
    );

    const results = page.locator(
      '[data-testid="absensi-table"], [data-testid="absensi-cards"]',
    );
    expect(
      await results.count(),
      'the results are on screen before they are searched for controls',
    ).toBeGreaterThan(0);
    expect(
      await results.locator('button, input, select, a[href]').count(),
      'the result region carries no create, edit or delete control',
    ).toBe(0);

    // --- Read-only, layer two: the verbs the address answers -------------
    // The read above still works through an ordinary request...
    const readable = await page.context().request.get(
      `${baseURL}/api/attendance/attendance?date=${today}`,
    );
    expect(readable.status(), 'the read itself must still answer').toBe(200);
    const readableBody = (await readable.json()) as { rows?: unknown };
    expect(Array.isArray(readableBody.rows)).toBe(true);

    // ... and every writing verb on the same address finds no route at all.
    const created = await page.context().request.post(
      `${baseURL}/api/attendance/attendance`,
      { data: { name: 'nobody' } },
    );
    expect(
      created.status(),
      'POST on the day view must not exist',
    ).toBe(404);

    const patched = await page.context().request.patch(
      `${baseURL}/api/attendance/attendance`,
      { data: { name: 'nobody' } },
    );
    expect(
      patched.status(),
      'PATCH on the day view must not exist',
    ).toBe(404);

    const removed = await page.context().request.delete(
      `${baseURL}/api/attendance/attendance`,
    );
    expect(
      removed.status(),
      'DELETE on the day view must not exist',
    ).toBe(404);

    // --- Sign out through the console's own control ----------------------
    await page.getByTestId('shell-sign-out').click();
    await expect(page).toHaveURL(/\/hrd\/login$/);
    await expect(page.getByTestId('login')).toBeVisible();
    await expect(page.getByTestId('shell-sign-out')).toHaveCount(0);

    // --- The run leaves nothing of itself behind -------------------------
    removeFixtures(marker);
    expect(
      psql(`SELECT count(*) FROM employees WHERE email LIKE '${marker}%'`),
      'the fixture people are gone',
    ).toBe('0');
    const sessionIdList = employeeIds.map((id) => `'${id}'`).join(', ');
    expect(
      psql(
        `SELECT count(*) FROM attendance_sessions WHERE employee_id IN (${sessionIdList})`,
      ),
      'the fixture sessions are gone',
    ).toBe('0');
    expect(
      psql(
        `SELECT count(*) FROM employees
          WHERE email IN ('ivan@company.com', 'ada@company.com')
            AND must_change_password = false`,
      ),
      'the seeded accounts keep the flags they opened with',
    ).toBe('2');
  } catch (error) {
    failure = error;
  }

  if (violations.length > 0) {
    console.error(
      `[read-only-attendance] ${violations.length} write attempt(s) left the page: ${violations.join(' | ')}`,
    );
  }
  if (failure !== null) {
    throw failure;
  }
  // A guard that never fired would report an empty list just as happily, so
  // it is held to the one writing flow this journey performs on purpose: the
  // sign-in had to pass through it on the way in.
  expect(
    permittedWrites.some((entry) => entry.includes('/api/identity/auth/login')),
    'the guard must have watched the sign-in it was told to wave through',
  ).toBe(true);
  expect(
    violations,
    'the day view never puts a writing verb on the wire',
  ).toEqual([]);
});
