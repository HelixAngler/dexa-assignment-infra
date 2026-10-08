import {
  expect,
  test,
  type Page,
  type WebSocket,
} from '@playwright/test';

import { en as englishDictionary } from '../../hrd-web/src/i18n/en';
import {
  id as indonesianDictionary,
  type DictKey,
} from '../../hrd-web/src/i18n/id';

/**
 * Two browser contexts against one running stack. The first keeps an HRD
 * console open; the second signs in as an employee and edits their own
 * profile. The edit must reach the open console as a plain, stacked banner
 * inside the time budget, without ever blocking the console, and a password
 * change must be announced as "password changed" without any password
 * material in the payload.
 *
 * The HRD console ships without a sign-in screen of its own, so its session
 * is created through the identity sign-in endpoint on the context's own
 * cookie jar before the console loads; everything after that is ordinary
 * browser traffic.
 */

const HRD_EMAIL = 'ivan@company.com';
const HRD_PASSWORD = 'HrdAdmin!2026';
const EMPLOYEE_EMAIL = 'ada@company.com';
const EMPLOYEE_PASSWORD = 'EmployeeDemo!2026';

/**
 * Password used while the journey runs. The seeded password is written back
 * before the test finishes so the demo account keeps working for whoever
 * runs this next.
 */
const STANDIN_PASSWORD = 'Banner-Journey-Temp-2026!';

/** Realtime channel the HRD console listens on for banner payloads. */
const ALERTS_CHANNEL = 'hrd:alerts';

/** Largest acceptable gap between a saved edit and its banner, in ms. */
const BANNER_BUDGET_MS = 5000;

/** How long the console may take to acknowledge the realtime subscription. */
const SUBSCRIPTION_TIMEOUT_MS = 15000;

/** Poll rhythm for "a new banner appeared" checks. */
const POLL_INTERVALS_MS = [50, 100, 250, 500];

/** Escapes regex metacharacters so dictionary text is matched literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches one banner line in whichever language the console currently shows.
 * The dictionary files are read rather than copied so the assertion can
 * never drift from the wording the console renders.
 */
function eitherLanguage(key: DictKey): RegExp {
  const variants = [indonesianDictionary[key], englishDictionary[key]].map(
    escapeRegExp,
  );
  return new RegExp(variants.join('|'));
}

/** Identifier of every banner currently in the console document. */
async function bannerIds(page: Page): Promise<(string | null)[]> {
  return page
    .getByTestId('alert-banner')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-alert-id')),
    );
}

/**
 * Resolves once the console's realtime connection has been told that the
 * alert channel subscription succeeded, so a later publish has a subscriber
 * to land on. Rejects listing every frame seen when no acknowledgement
 * arrives in time.
 */
function waitForAlertSubscription(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const seen: string[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new Error(
          `the ${ALERTS_CHANNEL} subscription was not acknowledged; frames seen: ${
            seen.join(' | ') || '(none)'
          }`,
        ),
      );
    }, SUBSCRIPTION_TIMEOUT_MS);
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    socket.on('framereceived', ({ payload }) => {
      const text =
        typeof payload === 'string' ? payload : payload.toString('utf8');
      seen.push(text);
      const isAcknowledgement =
        text.includes('"subscribe"') && !text.includes('"error"');
      if (isAcknowledgement) {
        finish();
      }
    });
  });
}

test('a profile change reaches the open HRD console as a banner', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);

  const baseURL = testInfo.project.use.baseURL ?? 'http://localhost:8080';
  const viewport = testInfo.project.use.viewport ?? {
    width: 1280,
    height: 720,
  };

  const hrdContext = await browser.newContext({ baseURL, viewport });
  const employeeContext = await browser.newContext({ baseURL, viewport });

  let standinApplied = false;
  let failure: unknown = null;

  try {
    // The console owner signs in first, then opens the console. Both
    // listeners are armed before the navigation so no early frame or early
    // response can slip past them.
    const hrdSignIn = await hrdContext.request.post(
      `${baseURL}/api/identity/auth/login`,
      { data: { email: HRD_EMAIL, password: HRD_PASSWORD } },
    );
    expect(hrdSignIn.status(), 'the HRD account must sign in').toBe(200);
    expect(await hrdSignIn.json()).toEqual({
      role: 'hrd',
      mustChangePassword: false,
    });

    const hrdPage = await hrdContext.newPage();
    const subscriptionReady = hrdPage
      .waitForEvent('websocket')
      .then((socket) => waitForAlertSubscription(socket));
    // Keeps a rejection quiet when an earlier step fails first; the journey
    // still awaits this promise on the happy path.
    subscriptionReady.catch(() => undefined);
    const recentResponse = hrdPage.waitForResponse((response) =>
      response.url().includes('/api/notification/alerts/recent'),
    );

    await hrdPage.goto('/hrd/');
    // The banner strip belongs to the console shell, so it exists even
    // before any alert has been queued.
    await expect(hrdPage.getByTestId('banner-region')).toBeAttached();

    const recent = await recentResponse;
    expect(recent.status(), 'the console pulls the alerts it missed').toBe(
      200,
    );
    const recentBody = (await recent.json()) as { alerts?: unknown };
    const pulled = Array.isArray(recentBody.alerts) ? recentBody.alerts : [];
    await expect(hrdPage.getByTestId('alert-banner')).toHaveCount(pulled.length);
    await subscriptionReady;

    // Everything already on screen belongs to earlier activity; only ids
    // outside this set may count as "the banner this journey is waiting for".
    const shownBefore = new Set(
      (await bannerIds(hrdPage)).filter((id): id is string => id !== null),
    );

    // The employee signs in through the real sign-in screen of their app.
    const employeePage = await employeeContext.newPage();
    await employeePage.goto('/');
    await employeePage.locator('#login-email').fill(EMPLOYEE_EMAIL);
    await employeePage.locator('#login-password').fill(EMPLOYEE_PASSWORD);
    await employeePage.getByTestId('login-submit').click();
    await expect(employeePage).toHaveURL(/\/absen$/);

    // Phone change through the profile screens.
    await employeePage.goto('/profil');
    await expect(employeePage.getByTestId('profil')).toBeVisible();
    await employeePage.locator('a[href="/profil/telepon"]').click();
    await expect(employeePage).toHaveURL(/\/profil\/telepon$/);
    await expect(employeePage.getByTestId('change-phone')).toBeVisible();

    const phone = `+62-8${Date.now().toString().slice(-9)}`;
    await employeePage.locator('#change-phone-number').fill(phone);
    const saveResponse = employeePage.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes('/api/identity/profile'),
    );
    await employeePage.getByTestId('phone-save').click();
    expect(
      (await saveResponse).status(),
      'the phone save must succeed',
    ).toBe(200);
    const savedAt = Date.now();

    await expect(employeePage).toHaveURL(/\/profil$/);
    await expect(employeePage.getByTestId('profil-phone')).toHaveText(phone);

    // The new banner must show up on the still-open console inside the
    // budget, measured from the moment the save was accepted.
    const found = { phoneAlertId: '' };
    let phoneLatencyMs = -1;
    await expect
      .poll(
        async () => {
          const fresh = (await bannerIds(hrdPage)).find(
            (id) => id !== null && id !== '' && !shownBefore.has(id),
          );
          if (fresh === undefined || fresh === null) {
            return false;
          }
          found.phoneAlertId = fresh;
          phoneLatencyMs = Date.now() - savedAt;
          return true;
        },
        {
          timeout: BANNER_BUDGET_MS,
          intervals: POLL_INTERVALS_MS,
          message: `a banner must reach the HRD console within ${BANNER_BUDGET_MS} ms of the saved phone change`,
        },
      )
      .toBe(true);
    expect(phoneLatencyMs).toBeLessThan(BANNER_BUDGET_MS);
    testInfo.annotations.push({
      type: 'banner-latency-phone',
      description: `${phoneLatencyMs} ms from saved phone change to banner`,
    });
    console.log(
      `[banner-journey] phone save → new banner: ${phoneLatencyMs} ms`,
    );

    const phoneBanner = hrdPage.locator(
      `[data-alert-id="${found.phoneAlertId}"]`,
    );
    await expect(phoneBanner).toBeVisible();
    await expect(phoneBanner).toHaveAttribute('role', 'alert');
    await expect(phoneBanner).toContainText(eitherLanguage('alert.field.phone'));

    // The banner is an ordinary element in the page flow: no dialog, no
    // inert background, and navigation still works while it is shown.
    await expect(hrdPage.locator('[role="dialog"]')).toHaveCount(0);
    expect(await hrdPage.locator('body').getAttribute('aria-hidden')).toBeNull();
    await hrdPage
      .locator('[data-testid="nav-desktop"] a[href="/hrd/absensi"]')
      .click();
    await expect(hrdPage).toHaveURL(/\/hrd\/absensi$/);
    await expect(phoneBanner).toBeVisible();
    await expect(hrdPage.locator('[role="dialog"]')).toHaveCount(0);
    await hrdPage
      .locator('[data-testid="nav-desktop"] a[href="/hrd/karyawan"]')
      .click();
    await expect(hrdPage).toHaveURL(/\/hrd\/karyawan$/);

    // Dismissal removes exactly that banner and leaves the rest alone.
    const othersBefore =
      (await bannerIds(hrdPage)).filter((id) => id !== found.phoneAlertId)
        .length;
    await phoneBanner.getByTestId('alert-banner-dismiss').click();
    await expect(
      hrdPage.locator(`[data-alert-id="${found.phoneAlertId}"]`),
    ).toHaveCount(0);
    await expect(hrdPage.getByTestId('alert-banner')).toHaveCount(othersBefore);

    // Password change: the console must say so without carrying any secret.
    const changeToStandin = await employeeContext.request.post(
      `${baseURL}/api/identity/auth/password/change`,
      {
        data: {
          currentPassword: EMPLOYEE_PASSWORD,
          newPassword: STANDIN_PASSWORD,
        },
      },
    );
    expect(
      changeToStandin.status(),
      'the password change must be accepted',
    ).toBe(200);
    standinApplied = true;
    const passwordChangedAt = Date.now();

    const password = { alertId: '' };
    await expect
      .poll(
        async () => {
          const fresh = (await bannerIds(hrdPage)).find(
            (id) =>
              id !== null &&
              id !== '' &&
              id !== found.phoneAlertId &&
              !shownBefore.has(id),
          );
          if (fresh === undefined || fresh === null) {
            return false;
          }
          password.alertId = fresh;
          return true;
        },
        {
          timeout: BANNER_BUDGET_MS,
          intervals: POLL_INTERVALS_MS,
          message: `a banner must reach the HRD console within ${BANNER_BUDGET_MS} ms of the saved password change`,
        },
      )
      .toBe(true);
    const passwordLatencyMs = Date.now() - passwordChangedAt;
    expect(passwordLatencyMs).toBeLessThan(BANNER_BUDGET_MS);
    testInfo.annotations.push({
      type: 'banner-latency-password',
      description: `${passwordLatencyMs} ms from saved password change to banner`,
    });
    console.log(
      `[banner-journey] password save → new banner: ${passwordLatencyMs} ms`,
    );

    const passwordBanner = hrdPage.locator(
      `[data-alert-id="${password.alertId}"]`,
    );
    await expect(passwordBanner).toBeVisible();
    await expect(passwordBanner).toHaveAttribute('role', 'alert');
    await expect(passwordBanner).toContainText(
      eitherLanguage('alert.passwordLine'),
    );
    await expect(hrdPage.locator('[role="dialog"]')).toHaveCount(0);
    expect(await hrdPage.locator('body').getAttribute('aria-hidden')).toBeNull();

    const rendered = (await passwordBanner.innerText()).toLowerCase();
    expect(rendered).not.toContain(EMPLOYEE_PASSWORD.toLowerCase());
    expect(rendered).not.toContain(STANDIN_PASSWORD.toLowerCase());

    await passwordBanner.getByTestId('alert-banner-dismiss').click();
    await expect(
      hrdPage.locator(`[data-alert-id="${password.alertId}"]`),
    ).toHaveCount(0);
  } catch (error) {
    failure = error;
  }

  // The demo account must end every run with its seeded password, whatever
  // went wrong above, so the next run signs in the same way.
  if (standinApplied) {
    const restore = await employeeContext.request.post(
      `${baseURL}/api/identity/auth/password/change`,
      {
        data: {
          currentPassword: STANDIN_PASSWORD,
          newPassword: EMPLOYEE_PASSWORD,
        },
      },
    );
    if (restore.status() !== 200) {
      const detail = `putting the demo password back answered ${restore.status()}: ${await restore.text()}`;
      if (failure === null) {
        failure = new Error(detail);
      } else {
        console.error(detail);
      }
    }
  }

  await hrdContext.close();
  await employeeContext.close();

  if (failure !== null) {
    throw failure;
  }
});
