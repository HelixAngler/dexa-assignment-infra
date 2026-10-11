import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

import { en as employeeEnglish } from '../../../employee-web/src/i18n/en';
import { id as employeeIndonesian, type DictKey } from '../../../employee-web/src/i18n/id';
import { expect, test } from '../fixtures';
import { allScreens, routeFor, screen, type ScreenEntry, type ScreenId } from '../screens';

/**
 * Whole-matrix regression: every screen id of both apps — the 13 employee
 * screens and the 10 console screens — exercised once per run, under every
 * project the harness config defines (two viewport shapes × two interface
 * languages). Writing each id once and letting the projects multiply it is
 * what keeps the full acceptance matrix enforceable as a single command:
 * 23 ids × 4 projects = 92 tests, all of them the same contract.
 *
 * The contract per screen is the union of the two audit dimensions the
 * per-app suites check separately:
 *
 *   layout — the document never scrolls sideways (scrollWidth ≤ clientWidth
 *     on both the document element and the body), no visible element box
 *     leaves the viewport horizontally, and every interactive control
 *     presents a box of at least 44×44 px;
 *   accessibility — axe-core, scoped to nothing, reports zero WCAG 2.x A and
 *     AA violations.
 *
 * Every assertion message names the screen id, the viewport the browser is
 * actually using, the seeded interface language, and the dimension that
 * failed, so a matrix cell can be read straight out of the failure without
 * cross-referencing the project name.
 *
 * Screens are reached without writing anything to the shared stack:
 * anonymous routes open signed out, session routes reuse a cookie obtained
 * by posting to the identity API through the browser context, and states
 * the harness cannot seed on the server are produced by answering the page's
 * own requests with that state's payload, so the screen renders it for real.
 * Each screen waits for a marker that proves the intended state is on screen
 * before anything is measured, so a screen that failed to load can never
 * pass silently.
 */

/** Seeded employee account; the profile, punch and summary screens reuse it. */
const EMPLOYEE_ACCOUNT = { email: 'ada@company.com', password: 'EmployeeDemo!2026' };

/** Seeded account whose password change is still pending at first sign-in. */
const FORCED_CHANGE_ACCOUNT = { email: 'eka@company.com', password: 'TempFirst!2026' };

/** The console's administrator account; the local stack seeds it. */
const HRD_ACCOUNT = { email: 'ivan@company.com', password: 'HrdAdmin!2026' };

/**
 * A seeded employee account. Signing into the console with it is how the
 * access-denied screen is reached: the guard replaces the shell entirely.
 */
const DENIED_ACCOUNT = EMPLOYEE_ACCOUNT;

/** Identity endpoints called through the browser context's cookie jar. */
const LOGIN_PATH = '/api/identity/auth/login';
const LOGOUT_PATH = '/api/identity/auth/logout';

/** URL patterns the employee app's own attendance requests are answered under. */
const PUNCH_STATE_URL = '**/api/attendance/punches/state';
const PUNCH_URL = '**/api/attendance/punches';

/** The axe-core rule tags this suite holds every screen against. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa'];

/** Smallest edge a touch target may have, on both axes. */
const MIN_TARGET_EDGE_PX = 44;

/** Rounding allowance when a box is compared against the viewport. */
const BOX_EPSILON_PX = 1;

/** Any account credential pair used to mint a session. */
interface Account {
  email: string;
  password: string;
}

/** Flat dictionary lookups for both interface languages of the employee app. */
type EmployeeDictionary = Record<DictKey, string>;

/** The dictionary the current project's language seeds into the employee app. */
function projectDictionary(designLang: 'id' | 'en'): EmployeeDictionary {
  return designLang === 'en' ? employeeEnglish : employeeIndonesian;
}

async function signIn(request: APIRequestContext, account: Account): Promise<void> {
  const response = await request.post(LOGIN_PATH, {
    data: { email: account.email, password: account.password },
  });
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
 * screen that silently fell back to another state fails here instead of
 * being measured as the wrong thing.
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
      throw new Error(`screen "${id}" is not an employee screen but reached the employee path`);
    }
  }
}

/**
 * Shape of one profile-change alert as the recent-alerts endpoint serves it:
 * the banner screens are driven with queues of these payloads.
 */
interface PulledAlert {
  alertId: string;
  employeeId: string;
  employeeName: string;
  changedFields: string[];
  before?: Record<string, string>;
  after?: Record<string, string>;
  passwordChanged: boolean;
  occurredAt: string;
}

/** One pulled profile-change alert used to drive the banner screens. */
function pulledAlert(index: number): PulledAlert {
  return {
    alertId: `qa-alert-${index}`,
    employeeId: `employee-${index}`,
    employeeName: `Employee ${index}`,
    changedFields: ['phone'],
    passwordChanged: false,
    occurredAt: '2026-10-07T10:12:33Z',
  };
}

/**
 * The banners a screen should show: the two banner screens are driven from
 * the recent-alerts pull, every other screen is kept banner-free so its
 * measurements cannot shift while a test runs.
 */
function queuedAlerts(id: ScreenId): PulledAlert[] {
  if (id === 'hrd.banner.single') {
    return [pulledAlert(1)];
  }
  if (id === 'hrd.banner.stack') {
    return [1, 2, 3, 4, 5].map(pulledAlert);
  }
  return [];
}

/**
 * Puts the console's notification endpoints under test control before the
 * page loads: the recent-alerts pull answers with a fixed queue, and the
 * live-channel token endpoint answers with a server error so no realtime
 * event can arrive while boxes are being measured. With the live channel
 * down the feed keeps the pulled banners on screen, which is all these
 * screens need.
 */
async function routeNotifications(page: Page, queued: PulledAlert[]): Promise<void> {
  await page.route('**/api/notification/alerts/recent*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ alerts: queued }),
    }),
  );
  await page.route('**/api/notification/realtime/auth', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'live channel unavailable' }),
    }),
  );
}

/**
 * Reads the id of one employee row off the list screen. `want: 'active'`
 * restricts the pick to a row whose status pill says the account is active,
 * which the deactivate-confirmation screen needs — its status radios only
 * offer the confirmation when the row starts out active.
 */
async function readEmployeeId(page: Page, want: 'any' | 'active'): Promise<string> {
  await page.goto(routeFor('hrd.karyawan.list'));
  await expect(
    page
      .locator('[data-testid="karyawan-table"]:visible, [data-testid="karyawan-cards"]:visible')
      .first(),
    'the list screen must render its rows',
  ).toBeVisible();

  const rows = page.locator('[data-testid="karyawan-row"], [data-testid="karyawan-card"]');
  const row =
    want === 'active'
      ? rows.filter({ has: page.locator('[data-testid="status-active"]') }).first()
      : rows.first();
  const link = row.locator('a[data-testid^="edit-"]').first();
  await expect(
    link,
    `the list must offer a suitable row with an edit link (want: ${want})`,
  ).toHaveAttribute('href', /\/karyawan\/[^/]+\/edit$/);
  const href = await link.getAttribute('href');
  const match = href === null ? null : /\/karyawan\/([^/]+)\/edit$/.exec(href);
  expect(match, `an edit link must expose its row id, got "${href ?? 'nothing'}"`).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

/** Reads one HR account id out of the Akun HR directory. */
async function readHrId(page: Page): Promise<string> {
  await page.goto(routeFor('hrd.hr.accounts'));
  await expect(
    page
      .locator('[data-testid="hr-accounts-table"]:visible, [data-testid="hr-accounts-cards"]:visible')
      .first(),
    'the HR directory must render its rows',
  ).toBeVisible();
  const link = page.locator('a[data-testid="hr-account-edit"]').first();
  await expect(link, 'the directory must offer an account with an edit link').toHaveAttribute(
    'href',
    /\/hr\/[^/]+\/edit$/,
  );
  const href = await link.getAttribute('href');
  const match = href === null ? null : /\/hr\/([^/]+)\/edit$/.exec(href);
  expect(match, `an edit link must expose its row id, got "${href ?? 'nothing'}"`).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

/**
 * Brings one console screen into the state its id names and leaves the page
 * ready to measure. Throws for ids without a recipe, so a screen added to
 * the map without one fails here instead of silently skipping.
 */
async function openConsoleScreen(page: Page, context: BrowserContext, id: ScreenId): Promise<void> {
  await routeNotifications(page, queuedAlerts(id));
  const target = screen(id);

  switch (id) {
    case 'hrd.login': {
      await page.goto(target.route);
      return;
    }
    case 'hrd.denied': {
      await signIn(context.request, DENIED_ACCOUNT);
      await page.goto(target.route);
      return;
    }
    case 'hrd.karyawan.list':
    case 'hrd.karyawan.add':
    case 'hrd.hr.accounts':
    case 'hrd.hr.add':
    case 'hrd.hr.approvals':
    case 'hrd.absensi': {
      await signIn(context.request, HRD_ACCOUNT);
      await page.goto(target.route);
      return;
    }
    case 'hrd.absensi.empty': {
      await signIn(context.request, HRD_ACCOUNT);
      await page.goto(target.route);
      await page.getByTestId('absensi-search').fill('no-employee-matches-this');
      await page.getByTestId('absensi-search-submit').click();
      return;
    }
    case 'hrd.karyawan.edit': {
      await signIn(context.request, HRD_ACCOUNT);
      const employeeId = await readEmployeeId(page, 'any');
      await page.goto(routeFor(id, { id: employeeId }));
      return;
    }
    case 'hrd.hr.edit': {
      await signIn(context.request, HRD_ACCOUNT);
      const hrId = await readHrId(page);
      await page.goto(routeFor(id, { id: hrId }));
      return;
    }
    case 'hrd.karyawan.deactivate': {
      await signIn(context.request, HRD_ACCOUNT);
      const employeeId = await readEmployeeId(page, 'active');
      await page.goto(routeFor(id, { id: employeeId }));
      await expect(page.getByTestId('karyawan-edit')).toBeVisible();
      await page.locator('input[name="employee-status"][value="deactivated"]').check();
      await page.getByTestId('status-apply').click();
      // The confirmation is captured open; its danger action is never
      // pressed, so no account state changes during QA.
      await expect(page.getByTestId('status-confirm')).toBeVisible();
      return;
    }
    case 'hrd.banner.single':
    case 'hrd.banner.stack': {
      await signIn(context.request, HRD_ACCOUNT);
      await page.goto(target.route);
      return;
    }
    default:
      throw new Error(`screen "${id}" is not a console screen but reached the console path`);
  }
}

/** Resolves once the console screen shows the content its id stands for. */
async function waitForConsoleReady(page: Page, id: ScreenId): Promise<void> {
  const visibleRows = () =>
    page.locator(
      '[data-testid="karyawan-row"]:visible, [data-testid="karyawan-card"]:visible, ' +
        '[data-testid="attendance-row"]:visible, [data-testid="attendance-card"]:visible',
    );

  switch (id) {
    case 'hrd.login':
      await expect(page.getByTestId('login')).toBeVisible();
      return;
    case 'hrd.karyawan.list':
      await expect(
        page
          .locator('[data-testid="karyawan-row"]:visible, [data-testid="karyawan-card"]:visible')
          .first(),
        'the list screen must render its rows',
      ).toBeVisible();
      return;
    case 'hrd.karyawan.add':
      await expect(page.getByTestId('employee-form')).toBeVisible();
      return;
    case 'hrd.karyawan.edit':
      await expect(page.getByTestId('karyawan-edit')).toBeVisible();
      await expect(
        page.locator('#employee-name'),
        'the edit form must carry the loaded row',
      ).not.toHaveValue('');
      return;
    case 'hrd.hr.accounts':
      await expect(
        page
          .locator('[data-testid="hr-account-row"]:visible, [data-testid="hr-account-card"]:visible')
          .first(),
        'the HR directory must render its rows',
      ).toBeVisible();
      return;
    case 'hrd.hr.add':
      await expect(page.getByTestId('hr-add')).toBeVisible();
      return;
    case 'hrd.hr.edit':
      await expect(page.getByTestId('hr-edit')).toBeVisible();
      await expect(
        page.locator('#hr-edit-name'),
        'the edit form must carry the loaded row',
      ).not.toHaveValue('');
      return;
    case 'hrd.hr.approvals':
      await expect(page.getByTestId('hr-approvals')).toBeVisible();
      return;
    case 'hrd.karyawan.deactivate':
      await expect(page.getByTestId('status-confirm')).toBeVisible();
      return;
    case 'hrd.absensi':
      await expect(
        page
          .locator('[data-testid="attendance-row"]:visible, [data-testid="attendance-card"]:visible')
          .first(),
        'the attendance view must render employee rows',
      ).toBeVisible();
      return;
    case 'hrd.absensi.empty':
      await expect(page.getByTestId('empty-state')).toBeVisible();
      return;
    case 'hrd.banner.single':
      await expect(
        page.getByTestId('alert-banner'),
        'the screen must show exactly one banner',
      ).toHaveCount(1);
      await expect(visibleRows().first(), 'the shell must also have loaded its page content').toBeVisible();
      return;
    case 'hrd.banner.stack':
      await expect
        .poll(() => page.getByTestId('alert-banner').count(), {
          message: 'the stack screen must show at least three banners',
        })
        .toBeGreaterThanOrEqual(3);
      await expect(visibleRows().first(), 'the shell must also have loaded its page content').toBeVisible();
      return;
    case 'hrd.denied':
      await expect(page.getByTestId('access-denied-state')).toBeVisible();
      return;
    default:
      throw new Error(`screen "${id}" has no console readiness condition`);
  }
}

/**
 * Brings one screen — whichever app serves it — into the state its id names
 * and reports whether a session was opened, so the caller can end it. Each
 * app keeps its own recipe because the two stacks drive their states
 * differently; the matrix itself only cares that the right state is on
 * screen before the contract is applied.
 */
async function bringScreenOnScreen(
  page: Page,
  context: BrowserContext,
  entry: ScreenEntry,
  dict: EmployeeDictionary,
): Promise<boolean> {
  if (entry.app === 'employee') {
    return reachEmployeeScreen(page, context, entry.id, dict);
  }
  await openConsoleScreen(page, context, entry.id);
  await waitForConsoleReady(page, entry.id);
  return entry.id !== 'hrd.login';
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

interface LayoutAudit {
  scroll: {
    documentScrollWidth: number;
    documentClientWidth: number;
    bodyScrollWidth: number;
    bodyClientWidth: number;
  };
  outside: string[];
  undersized: string[];
  /** How much was actually measured: guards the checks against going blind. */
  scanned: { visibleElements: number; measuredTargets: number };
}

/**
 * Measures the rendered page once and returns everything the layout
 * assertions need: the scroll widths, the boxes that leave the viewport
 * horizontally, and the interactive controls below the minimum target size.
 */
async function measureLayout(page: Page): Promise<LayoutAudit> {
  return page.evaluate(
    ({ minTargetEdge, boxEpsilon }) => {
      const INTERACTIVE = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        'summary',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="switch"]',
        '[role="tab"]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(',');

      /** A short, stable handle for a node in an assertion message. */
      const describe = (element: Element): string => {
        const tag = element.tagName.toLowerCase();
        const id = element.id === '' ? '' : `#${element.id}`;
        const testId = element.getAttribute('data-testid');
        const testIdPart = testId === null ? '' : `[data-testid="${testId}"]`;
        const className =
          typeof element.className === 'string' && element.className.trim() !== ''
            ? `.${element.className.trim().split(/\s+/).slice(0, 4).join('.')}`
            : '';
        return `${tag}${id}${testIdPart}${className}`;
      };

      /** Whether the element paints at all (display, visibility, size). */
      const isVisible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          Number(style.opacity) === 0
        ) {
          return false;
        }
        const box = element.getBoundingClientRect();
        return box.width > 0 || box.height > 0;
      };

      /**
       * Whether an ancestor clips this element horizontally. A descendant
       * that only overflows inside a scrolling container never widens the
       * page and never scrolls the viewport, so it must not be reported —
       * the container itself is measured like every other box.
       */
      const clippedByAncestor = (element: Element): boolean => {
        for (
          let parent = element.parentElement;
          parent !== null;
          parent = parent.parentElement
        ) {
          if (window.getComputedStyle(parent).overflowX !== 'visible') {
            return true;
          }
        }
        return false;
      };

      const scroll = {
        documentScrollWidth: document.documentElement.scrollWidth,
        documentClientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
      };

      const viewportWidth = document.documentElement.clientWidth;

      const outside: string[] = [];
      let visibleElements = 0;
      for (const element of [document.body, ...Array.from(document.body.querySelectorAll('*'))]) {
        if (!isVisible(element)) {
          continue;
        }
        visibleElements += 1;
        if (clippedByAncestor(element)) {
          continue;
        }
        const box = element.getBoundingClientRect();
        if (box.right <= viewportWidth + boxEpsilon && box.left >= -boxEpsilon) {
          continue;
        }
        outside.push(
          `${describe(element)} spans left=${Math.round(box.left)} right=${Math.round(box.right)} inside a 0…${viewportWidth} viewport`,
        );
      }

      const undersized: string[] = [];
      let measuredTargets = 0;
      for (const element of Array.from(document.querySelectorAll(INTERACTIVE))) {
        if (!isVisible(element)) {
          continue;
        }
        measuredTargets += 1;
        const box = element.getBoundingClientRect();
        if (box.width >= minTargetEdge && box.height >= minTargetEdge) {
          continue;
        }
        undersized.push(
          `${describe(element)} measures ${Math.round(box.width)}×${Math.round(box.height)} px, below ${minTargetEdge}×${minTargetEdge}`,
        );
      }

      return { scroll, outside, undersized, scanned: { visibleElements, measuredTargets } };
    },
    { minTargetEdge: MIN_TARGET_EDGE_PX, boxEpsilon: BOX_EPSILON_PX },
  );
}

// Screens are independent of each other: each one opens its own context.
test.describe.configure({ mode: 'parallel' });

for (const entry of allScreens()) {
  test(entry.id, async ({ context, designLang, page }) => {
    const dict = projectDictionary(designLang);
    const viewport = page.viewportSize();
    const cell = `${entry.id} @ ${viewport?.width ?? 0}×${viewport?.height ?? 0} / "${designLang}"`;

    const signedIn = await bringScreenOnScreen(page, context, entry, dict);

    try {
      await page.evaluate(async () => {
        await document.fonts.ready;
      });

      const audit = await measureLayout(page);

      expect(
        audit.scanned.visibleElements,
        `[layout-visible-content] ${cell} must render visible content, ` +
          'otherwise the box checks measure nothing',
      ).toBeGreaterThan(0);

      expect(
        audit.scanned.measuredTargets,
        `[layout-target-present] ${cell} must render at least one interactive control, ` +
          'otherwise the 44×44 check measures nothing',
      ).toBeGreaterThan(0);

      expect(
        audit.scroll.documentScrollWidth,
        `[layout-horizontal-scroll/document] ${cell} must not scroll sideways ` +
          `(scrollWidth ${audit.scroll.documentScrollWidth} > clientWidth ${audit.scroll.documentClientWidth})`,
      ).toBeLessThanOrEqual(audit.scroll.documentClientWidth);

      expect(
        audit.scroll.bodyScrollWidth,
        `[layout-horizontal-scroll/body] ${cell} must not scroll sideways ` +
          `(scrollWidth ${audit.scroll.bodyScrollWidth} > clientWidth ${audit.scroll.bodyClientWidth})`,
      ).toBeLessThanOrEqual(audit.scroll.bodyClientWidth);

      expect(
        audit.outside,
        `[layout-outside-viewport] ${cell}: no element box may leave the viewport horizontally ` +
          `— ${audit.outside.join('; ')}`,
      ).toEqual([]);

      expect(
        audit.undersized,
        `[layout-target-size] ${cell}: every interactive element must be at least ` +
          `${MIN_TARGET_EDGE_PX}×${MIN_TARGET_EDGE_PX} px — ${audit.undersized.join('; ')}`,
      ).toEqual([]);

      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const report = results.violations.map(describeViolation).join('\n');

      expect(
        results.violations,
        `[axe-wcag2aa] ${cell}: axe must report no WCAG A/AA violation\n${report}`,
      ).toEqual([]);
    } finally {
      if (signedIn) {
        await signOut(context.request);
      }
    }
  });
}
