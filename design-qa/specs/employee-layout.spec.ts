import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';

import { en as employeeEnglish } from '../../../employee-web/src/i18n/en';
import { id as employeeIndonesian, type DictKey } from '../../../employee-web/src/i18n/id';
import { expect, test } from '../fixtures';
import { routeFor, screensOf, type ScreenId } from '../screens';

/**
 * Layout QA for the employee app: every employee screen of the screen map,
 * measured at the viewport and rendered in the language the running project
 * selects (this harness seeds the language before the app's first render, so
 * all four projects × locales are covered by running this file as-is).
 *
 * Three properties are checked on every screen:
 *
 *   1. the document never scrolls sideways — scrollWidth ≤ clientWidth on
 *      both the document element and the body;
 *   2. no visible element box sticks out of the viewport horizontally;
 *      vertical overflow is ordinary page scrolling and is not a defect,
 *      horizontal overflow always is;
 *   3. every interactive control (link, button, input, select and their
 *      ARIA-role twins) presents a box of at least 44×44 px.
 *
 * Screens are reached without writing anything to the shared stack:
 * anonymous routes open signed out, session routes reuse a cookie obtained
 * by posting to the identity API through the browser context, and states
 * the harness cannot seed on the server are produced by answering the page's
 * own requests with that state's payload, so the screen renders it for real.
 * Every screen waits for an assertion that proves the intended state is on
 * screen before the measurements run, so a screen that failed to load can
 * never pass silently.
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

/** Smallest edge a touch target may have, on both axes. */
const MIN_TARGET_EDGE_PX = 44;

/** Rounding allowance when a box is compared against the viewport. */
const BOX_EPSILON_PX = 1;

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
 * screen that silently fell back to another state fails here instead of
 * being measured.
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
 * Measures the rendered page once and returns everything the three layout
 * assertions need: the scroll widths, the boxes that leave the viewport
 * horizontally, and the interactive controls below the minimum target size.
 */
async function measureLayout(page: Page): Promise<LayoutAudit> {
  return page.evaluate(({ minTargetEdge, boxEpsilon }) => {
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
     * Whether an ancestor clips this element horizontally. A descendant that
     * only overflows inside a scrolling container never widens the page and
     * never scrolls the viewport, so it must not be reported — the container
     * itself is measured like every other box.
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
  }, { minTargetEdge: MIN_TARGET_EDGE_PX, boxEpsilon: BOX_EPSILON_PX });
}

// Screens are independent of each other: each one opens its own context.
test.describe.configure({ mode: 'parallel' });

for (const entry of screensOf('employee')) {
  test(entry.id, async ({ context, designLang, page }) => {
    const dict = projectDictionary(designLang);
    const signedIn = await reachEmployeeScreen(page, context, entry.id, dict);

    try {
      const audit = await measureLayout(page);

      expect(
        audit.scanned.visibleElements,
        `${entry.id} must render visible content, otherwise the box checks measure nothing`,
      ).toBeGreaterThan(0);

      expect(
        audit.scanned.measuredTargets,
        `${entry.id} must render at least one interactive control, otherwise the target-size check measures nothing`,
      ).toBeGreaterThan(0);

      expect(
        audit.scroll.documentScrollWidth,
        `the document must not scroll horizontally on ${entry.id} ` +
          `(scrollWidth ${audit.scroll.documentScrollWidth} > clientWidth ${audit.scroll.documentClientWidth})`,
      ).toBeLessThanOrEqual(audit.scroll.documentClientWidth);

      expect(
        audit.scroll.bodyScrollWidth,
        `the body must not scroll horizontally on ${entry.id} ` +
          `(scrollWidth ${audit.scroll.bodyScrollWidth} > clientWidth ${audit.scroll.bodyClientWidth})`,
      ).toBeLessThanOrEqual(audit.scroll.bodyClientWidth);

      expect(
        audit.outside,
        `no element box may leave the viewport horizontally on ${entry.id}:\n${audit.outside.join('\n')}`,
      ).toEqual([]);

      expect(
        audit.undersized,
        `every interactive element must be at least ${MIN_TARGET_EDGE_PX}×${MIN_TARGET_EDGE_PX} px on ${entry.id}:\n${audit.undersized.join('\n')}`,
      ).toEqual([]);
    } finally {
      if (signedIn) {
        await signOut(context.request);
      }
    }
  });
}
