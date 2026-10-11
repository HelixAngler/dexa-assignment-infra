import type { BrowserContext, Page } from '@playwright/test';

import { expect, test } from '../fixtures';
import { routeFor, screen, screensOf, type ScreenId } from '../screens';

/**
 * Layout QA for the HRD console: one test per console screen id of the
 * screen map, measured at the viewport and rendered in the language the
 * running project selects (this harness seeds the language before the app's
 * first render, so all four projects × locales are covered by running this
 * file as-is).
 *
 * Three properties are checked on every screen:
 *
 *   1. the page never scrolls sideways — scrollWidth ≤ clientWidth on both
 *      the document element and the body;
 *   2. no visible element box sticks out of the viewport horizontally;
 *      vertical overflow is ordinary page scrolling and is not a defect,
 *      horizontal overflow always is;
 *   3. every interactive control (link, button, input, select and their
 *      ARIA-role twins) presents a box of at least 44x44 px.
 *
 * Two sanity guards make sure the box checks cannot go blind: a screen has
 * to render visible content and at least one interactive control before the
 * measurements are accepted.
 *
 * Screens are opened exactly the way ./screens.ts records: a session is
 * minted once per test by posting credentials to the identity API with the
 * context's request object (the cookie lands in the browser context the
 * test's page reuses), fixture screens add their own set-up — a row id read
 * off the list, an opened confirmation, a filtered-empty view, or a mocked
 * notification pull — and the test signs out again when it is done.
 */

/** The console's administrator account; the local stack seeds it. */
const HRD_ACCOUNT = { email: 'ivan@company.com', password: 'HrdAdmin!2026' };

/**
 * A seeded employee account. Signing into the console with it is how the
 * access-denied screen is reached: the guard replaces the shell entirely.
 */
const EMPLOYEE_ACCOUNT = { email: 'ada@company.com', password: 'EmployeeDemo!2026' };

/** Smallest edge a touch target may have, on both axes. */
const MIN_TARGET_EDGE_PX = 44;

/** Rounding allowance when a box is compared against the viewport. */
const BOX_EPSILON_PX = 1;

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
 * the recent-alerts pull (see routeNotifications), every other screen is kept
 * banner-free so its measurements cannot shift while a test runs.
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
 * captures need.
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

async function signIn(
  context: BrowserContext,
  account: { email: string; password: string },
): Promise<void> {
  const response = await context.request.post('/api/identity/auth/login', {
    data: { email: account.email, password: account.password },
  });
  expect(response.status(), `${account.email} must be able to sign in`).toBe(200);
}

async function signOut(context: BrowserContext): Promise<void> {
  await context.request.post('/api/identity/auth/logout');
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
    page.locator('[data-testid="karyawan-table"]:visible, [data-testid="karyawan-cards"]:visible').first(),
    'the list screen must render its rows',
  ).toBeVisible();

  const rows = page.locator('[data-testid="karyawan-row"], [data-testid="karyawan-card"]');
  const row =
    want === 'active'
      ? rows.filter({ has: page.locator('[data-testid="status-active"]') }).first()
      : rows.first();
  const link = row.locator('a[data-testid^="edit-"]').first();
  await expect(link, `the list must offer a suitable row with an edit link (want: ${want})`).toHaveAttribute(
    'href',
    /\/karyawan\/[^/]+\/edit$/,
  );
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
 * ready for measurement. Throws for ids without a recipe, so a screen added
 * to the map without one fails here instead of silently skipping.
 */
async function openScreen(
  page: Page,
  context: BrowserContext,
  id: ScreenId,
): Promise<void> {
  await routeNotifications(page, queuedAlerts(id));
  const target = screen(id);

  switch (id) {
    case 'hrd.login': {
      await page.goto(target.route);
      return;
    }
    case 'hrd.denied': {
      await signIn(context, EMPLOYEE_ACCOUNT);
      await page.goto(target.route);
      return;
    }
    case 'hrd.karyawan.list':
    case 'hrd.karyawan.add':
    case 'hrd.hr.accounts':
    case 'hrd.hr.add':
    case 'hrd.hr.approvals':
    case 'hrd.absensi': {
      await signIn(context, HRD_ACCOUNT);
      await page.goto(target.route);
      return;
    }
    case 'hrd.absensi.empty': {
      await signIn(context, HRD_ACCOUNT);
      await page.goto(target.route);
      await page.getByTestId('absensi-search').fill('no-employee-matches-this');
      await page.getByTestId('absensi-search-submit').click();
      return;
    }
    case 'hrd.karyawan.edit': {
      await signIn(context, HRD_ACCOUNT);
      const employeeId = await readEmployeeId(page, 'any');
      await page.goto(routeFor(id, { id: employeeId }));
      return;
    }
    case 'hrd.hr.edit': {
      await signIn(context, HRD_ACCOUNT);
      const hrId = await readHrId(page);
      await page.goto(routeFor(id, { id: hrId }));
      return;
    }
    case 'hrd.karyawan.deactivate': {
      await signIn(context, HRD_ACCOUNT);
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
      await signIn(context, HRD_ACCOUNT);
      await page.goto(target.route);
      return;
    }
    default:
      throw new Error(`screen "${id}" has no reach recipe in this spec`);
  }
}

/** Resolves once the screen shows the content its id stands for. */
async function waitForScreenReady(page: Page, id: ScreenId): Promise<void> {
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
        page.locator('[data-testid="karyawan-row"]:visible, [data-testid="karyawan-card"]:visible').first(),
        'the list screen must render its rows',
      ).toBeVisible();
      return;
    case 'hrd.karyawan.add':
      await expect(page.getByTestId('employee-form')).toBeVisible();
      return;
    case 'hrd.karyawan.edit':
      await expect(page.getByTestId('karyawan-edit')).toBeVisible();
      await expect(page.locator('#employee-name'), 'the edit form must carry the loaded row').not.toHaveValue('');
      return;
    case 'hrd.karyawan.deactivate':
      await expect(page.getByTestId('status-confirm')).toBeVisible();
      return;
    case 'hrd.hr.accounts':
      await expect(page.locator('[data-testid="hr-account-row"]:visible, [data-testid="hr-account-card"]:visible').first(), 'the HR directory must render its rows').toBeVisible();
      return;
    case 'hrd.hr.add':
      await expect(page.getByTestId('hr-add')).toBeVisible();
      return;
    case 'hrd.hr.edit':
      await expect(page.getByTestId('hr-edit')).toBeVisible();
      await expect(page.locator('#hr-edit-name'), 'the edit form must carry the loaded row').not.toHaveValue('');
      return;
    case 'hrd.hr.approvals':
      await expect(page.getByTestId('hr-approvals')).toBeVisible();
      return;
    case 'hrd.absensi':
      await expect(
        page.locator('[data-testid="attendance-row"]:visible, [data-testid="attendance-card"]:visible').first(),
        'the attendance view must render employee rows',
      ).toBeVisible();
      return;
    case 'hrd.absensi.empty':
      await expect(page.getByTestId('empty-state')).toBeVisible();
      return;
    case 'hrd.banner.single':
      await expect(page.getByTestId('alert-banner'), 'the screen must show exactly one banner').toHaveCount(1);
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
      throw new Error(`screen "${id}" has no readiness condition in this spec`);
  }
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

for (const { id } of screensOf('hrd')) {
  test(id, async ({ context, page }) => {
    try {
      await openScreen(page, context, id);
      await waitForScreenReady(page, id);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });

      const audit = await measureLayout(page);

      expect(
        audit.scanned.visibleElements,
        `${id} must render visible content, otherwise the box checks measure nothing`,
      ).toBeGreaterThan(0);

      expect(
        audit.scanned.measuredTargets,
        `${id} must render at least one interactive control, otherwise the target-size check measures nothing`,
      ).toBeGreaterThan(0);

      expect(
        audit.scroll.documentScrollWidth,
        `the document must not scroll horizontally on ${id} ` +
          `(scrollWidth ${audit.scroll.documentScrollWidth} > clientWidth ${audit.scroll.documentClientWidth})`,
      ).toBeLessThanOrEqual(audit.scroll.documentClientWidth);

      expect(
        audit.scroll.bodyScrollWidth,
        `the body must not scroll horizontally on ${id} ` +
          `(scrollWidth ${audit.scroll.bodyScrollWidth} > clientWidth ${audit.scroll.bodyClientWidth})`,
      ).toBeLessThanOrEqual(audit.scroll.bodyClientWidth);

      expect(
        audit.outside,
        `no element box may leave the viewport horizontally on ${id}:\n${audit.outside.join('\n')}`,
      ).toEqual([]);

      expect(
        audit.undersized,
        `every interactive element must be at least ${MIN_TARGET_EDGE_PX}×${MIN_TARGET_EDGE_PX} px on ${id}:\n${audit.undersized.join('\n')}`,
      ).toEqual([]);
    } finally {
      await signOut(context);
    }
  });
}
