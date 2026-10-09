import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

import { en as employeeEnglish } from '../../../employee-web/src/i18n/en';
import { id as employeeIndonesian, type DictKey } from '../../../employee-web/src/i18n/id';
import { expect, test } from '../fixtures';
import { routeFor, screensOf, type ScreenId } from '../screens';

/**
 * Contrast and accessibility QA for the employee app: axe-core is run over
 * every employee screen of the screen map, in the language the running
 * project seeds into the app, and the suite fails on any WCAG 2.x A or AA
 * violation. The four projects of this harness (two viewports × two
 * languages) mean running this file as-is covers every screen in both
 * locales at both screen shapes; no rule is disabled and no result is
 * filtered, so a violation cannot be hidden by configuration.
 *
 * Screens are reached without writing anything to the shared stack:
 * anonymous routes open signed out, session routes reuse a cookie obtained
 * by posting to the identity API through the browser context, and states
 * the harness cannot seed on the server are produced by answering the page's
 * own requests with that state's payload, so the screen renders it for real.
 * Every screen waits for an assertion that proves the intended state is on
 * screen before axe runs, so a screen that failed to load can never pass
 * silently.
 */

/** Seeded employee account; the profile, punch and summary screens reuse it. */
const EMPLOYEE_ACCOUNT = { email: 'ada@company.com', password: 'EmployeeDemo!2026' };

/** Seeded account whose password change is still pending at first sign-in. */
const FORCED_CHANGE_ACCOUNT = { email: 'eka@company.com', password: 'TempFirst!2026' };

/** Identity endpoints called through the browser context's cookie jar. */
const LOGIN_PATH = '/api/identity/auth/login';
const LOGOUT_PATH = '/api/identity/auth/logout';

/** URL patterns the page's own attendance requests are answered under. */
const PUNCH_STATE_URL = '**/api/attendance/punches/state';
const PUNCH_URL = '**/api/attendance/punches';

/** The axe-core rule tags this suite holds every screen against. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa'];

/** Flat dictionary lookups for both interface languages of the app. */
type EmployeeDictionary = Record<DictKey, string>;

/** The dictionary the current project's language seeds into the app. */
function projectDictionary(designLang: 'id' | 'en'): EmployeeDictionary {
  return designLang === 'en' ? employeeEnglish : employeeIndonesian;
}

async function signIn(request: APIRequestContext, account: typeof EMPLOYEE_ACCOUNT) {
  const response = await request.post(LOGIN_PATH, { data: account });
  expect(
    response.ok(),
    `sign-in for ${account.email} must be accepted, got HTTP ${response.status()}`,
  ).toBe(true);
}

async function signOut(request: APIRequestContext): Promise<void> {
  await request.post(LOGOUT_PATH);
}

/** Serves a fixed punch state so a screen shows a known state read-only. */
async function servePunchState(page: Page, state: Record<string, unknown>): Promise<void> {
  await page.route(PUNCH_STATE_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(state),
    }),
  );
}

/** Answers the punch submission with the conflict the server would refuse with. */
async function serveConflictingPunch(page: Page): Promise<void> {
  await page.route(PUNCH_URL, (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        statusCode: 409,
        code: 'SESSION_ALREADY_OPEN',
        message:
          'Anda sudah absen masuk dan sesi masih berbuka. Silakan absen pulang terlebih dahulu.',
      }),
    }),
  );
}

/** Drops the punch submission on the floor, exactly like a lost connection. */
async function serveUnreachablePunch(page: Page): Promise<void> {
  await page.route(PUNCH_URL, (route) => route.abort('failed'));
}

/**
 * Renders the locked sign-in state: the page gets the lockout answer the
 * identity service returns after repeated failed attempts, so the lock copy
 * appears without locking a real seeded account on the shared stack.
 */
async function showLockedSignIn(page: Page, dict: EmployeeDictionary): Promise<void> {
  await page.route(`**${LOGIN_PATH}`, (route) =>
    route.fulfill({
      status: 423,
      contentType: 'application/json',
      body: JSON.stringify({
        statusCode: 423,
        code: 'AUTH_LOCKED',
        message: dict['login.error.locked'],
      }),
    }),
  );

  await page.goto('/login');
  await expect(page.getByTestId('login')).toBeVisible();
  await page.locator('#login-email').fill(EMPLOYEE_ACCOUNT.email);
  await page.locator('#login-password').fill('rejected-attempt');
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('login-error')).toHaveText(dict['login.error.locked']);
}

/**
 * Brings the requested employee screen on screen in its intended state and
 * reports whether a session was opened (the caller then signs out again).
 * Each branch ends with an assertion on that screen's own marker, so a
 * screen that silently fell back to another state is measured instead of
 * the one this id stands for.
 */
async function reachEmployeeScreen(
  page: Page,
  context: BrowserContext,
  id: ScreenId,
  dict: EmployeeDictionary,
): Promise<boolean> {
  switch (id) {
    case 'emp.login': {
      await page.goto(routeFor(id));
      await expect(page.getByTestId('login')).toBeVisible();
      return false;
    }
    case 'emp.login.locked': {
      await showLockedSignIn(page, dict);
      return false;
    }
    case 'emp.first-login': {
      // The forced-change flag reaches the route guard only through the
      // sign-in this tab performs itself, so the form is driven here instead
      // of posting the credentials straight to the identity API.
      await page.goto('/login');
      await expect(page.getByTestId('login')).toBeVisible();
      await page.locator('#login-email').fill(FORCED_CHANGE_ACCOUNT.email);
      await page.locator('#login-password').fill(FORCED_CHANGE_ACCOUNT.password);
      await page.getByTestId('login-submit').click();
      await expect(page).toHaveURL(/\/first-login$/);
      await expect(page.getByTestId('first-login')).toBeVisible();
      await expect(page.locator('#first-login-new-password')).toBeVisible();
      return true;
    }
    case 'emp.profil': {
      await signIn(context.request, EMPLOYEE_ACCOUNT);
      await page.goto(routeFor(id));
      await expect(page.getByTestId('profil-name')).toBeVisible();
      return true;
    }
    case 'emp.profil.phone': {
      await signIn(context.request, EMPLOYEE_ACCOUNT);
      await page.goto(routeFor(id));
      await expect(page.locator('#change-phone-number')).toBeVisible();
      await page.locator('#change-phone-number').fill('123');
      await expect(page.getByTestId('phone-error')).toBeVisible();
      return true;
    }
    case 'emp.profil.photo': {
      await signIn(context.request, EMPLOYEE_ACCOUNT);
      await page.goto(routeFor(id));
      await expect(page.getByTestId('photo-input')).toBeVisible();
      await page.getByTestId('photo-input').setInputFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('not an image'),
      });
      await expect(page.getByTestId('photo-error')).toBeVisible();
      return true;
    }
    case 'emp.profil.password': {
      await signIn(context.request, EMPLOYEE_ACCOUNT);
      await page.goto(routeFor(id));
      await expect(page.locator('#change-password-current')).toBeVisible();
      await page.locator('#change-password-current').fill('irrelevant-attempt');
      await page.locator('#change-password-new').fill('abcdefgh');
      await page.locator('#change-password-confirm').fill('abcdefgh2');
      await page.getByTestId('password-save').click();
      await expect(page.getByTestId('password-error')).toBeVisible();
      return true;
    }
    case 'emp.absen.baru': {
      await signIn(context.request, EMPLOYEE_ACCOUNT);
      await servePunchState(page, {
        status: 'belum_masuk',
        lastPunch: { direction: 'pulang', at: hoursAgoIso(30) },
      });
      await page.goto(routeFor(id));
      await expect(page.getByTestId('absen-status')).toHaveText(
        dict['absen.status.belumMasuk'],
      );
      await expect(page.getByTestId('punch-button')).toHaveText(dict['absen.punch.masuk']);
      return true;
    }
    case 'emp.absen.kerja': {
      await signIn(context.request, EMPLOYEE_ACCOUNT);
      await servePunchState(page, {
        status: 'bekerja',
        clockInAt: hoursAgoIso(2),
        lastPunch: { direction: 'masuk', at: hoursAgoIso(2) },
      });
      await page.goto(routeFor(id));
      await expect(page.getByTestId('absen-status')).toHaveText(
        dict['absen.status.bekerja'],
      );
      await expect(page.getByTestId('punch-button')).toHaveText(dict['absen.punch.pulang']);
      await expect(page.getByTestId('absen-clock-in')).toBeVisible();
      return true;
    }
    case 'emp.absen.conflict': {
      await signIn(context.request, EMPLOYEE_ACCOUNT);
      await servePunchState(page, { status: 'belum_masuk' });
      await serveConflictingPunch(page);
      await page.goto(routeFor(id));
      await expect(page.getByTestId('absen-status')).toHaveText(
        dict['absen.status.belumMasuk'],
      );
      await page.getByTestId('punch-button').click();
      await expect(page.getByTestId('conflict-overlay')).toBeVisible();
      return true;
    }
    case 'emp.absen.offline': {
      await signIn(context.request, EMPLOYEE_ACCOUNT);
      await servePunchState(page, { status: 'belum_masuk' });
      await serveUnreachablePunch(page);
      await page.goto(routeFor(id));
      await expect(page.getByTestId('absen-status')).toHaveText(
        dict['absen.status.belumMasuk'],
      );
      await page.getByTestId('punch-button').click();
      await expect(page.getByTestId('network-error-overlay')).toBeVisible();
      return true;
    }
    case 'emp.summary.default': {
      await signIn(context.request, EMPLOYEE_ACCOUNT);
      await page.goto(routeFor(id));
      await expect(page.getByTestId('summary')).toBeVisible();
      await expect(page.getByTestId('loading-state')).toHaveCount(0);
      return true;
    }
    case 'emp.summary.empty': {
      await signIn(context.request, EMPLOYEE_ACCOUNT);
      await page.goto(routeFor(id));
      await expect(page.getByTestId('summary')).toBeVisible();
      await expect(page.getByTestId('loading-state')).toHaveCount(0);
      await page.getByTestId('summary-from').fill('2077-01-01');
      await page.getByTestId('summary-to').fill('2077-01-31');
      await page.getByTestId('summary-search').click();
      await expect(page.getByTestId('empty-state')).toBeVisible();
      return true;
    }
    default: {
      throw new Error(`employee screen "${id}" has no reach recipe in this spec`);
    }
  }
}

/** An ISO instant the given number of hours before now. */
function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/** One violation reduced to a line an assertion failure can be read from. */
function describeViolation(violation: {
  id: string;
  impact?: string | null;
  help: string;
  nodes: { target: unknown[] }[];
}): string {
  const targets = violation.nodes
    .slice(0, 5)
    .map((node) => node.target.join(' '))
    .join(', ');
  const more = violation.nodes.length > 5 ? ` (+${violation.nodes.length - 5} more)` : '';
  return `${violation.id} [${violation.impact ?? 'n/a'}] ${violation.help}: ${violation.nodes.length} node(s) → ${targets}${more}`;
}

// Screens are independent of each other: each one opens its own context.
test.describe.configure({ mode: 'parallel' });

for (const entry of screensOf('employee')) {
  test(entry.id, async ({ context, designLang, page }) => {
    const dict = projectDictionary(designLang);
    const signedIn = await reachEmployeeScreen(page, context, entry.id, dict);

    try {
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const report = results.violations.map(describeViolation).join('\n');

      expect(
        results.violations,
        `axe must report no WCAG A/AA violation on ${entry.id}:\n${report}`,
      ).toEqual([]);
    } finally {
      if (signedIn) {
        await signOut(context.request);
      }
    }
  });
}
