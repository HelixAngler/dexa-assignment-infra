import { execFileSync } from 'node:child_process';

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  id as employeeDictionary,
  type DictKey as EmployeeDictKey,
} from '../../employee-web/src/i18n/id';
import {
  id as hrdDictionary,
  type DictKey as HrdDictKey,
} from '../../hrd-web/src/i18n/id';

/**
 * The whole employee lifecycle driven through the HRD console itself against
 * the running stack.
 *
 * One address is minted for this run and for nobody else. The console creates
 * the account on its own create screen; the one-time password that save
 * reveals is then used in a second browser context where the forced first
 * change owns every address until it is saved, and a punch from that context
 * proves the account is a real one. The record is edited, its password is
 * reset, and the account is deactivated and activated again — at each step
 * checking that the employee app accepts or refuses the sign-in exactly as
 * the console says, that a second account on the same address is refused, and
 * that the row still shows the same person at the end.
 *
 * Nothing seeded is ever written: the console administrator only signs in and
 * out, no global row count is asserted, and every password the journey uses
 * belongs to the account it creates. The employee row has no delete route in
 * the console, so it is left behind deactivated, which is also what drops its
 * sessions; the punch row it writes is removed afterwards.
 */

/** Compose project the stack runs under; used to reach its containers. */
const COMPOSE_PROJECT = 'infra';
const DB_USER = 'wfh';
const DB_NAME = 'wfh_main';

/** The console's administrator account; it is only ever signed in and out. */
const HRD_EMAIL = 'ivan@company.com';
const HRD_PASSWORD = 'HrdAdmin!2026';

/** Password the account carries once the forced first change is done. */
const FIRST_CHOSEN_PASSWORD = 'Employees-First!2026';

/** Password chosen after the reset; the account ends with this one. */
const AFTER_RESET_PASSWORD = 'Employees-Reset!2026';

/** Profile written on create, and the pair of columns the edit changes. */
const EMPLOYEE_NAME = 'Karyawan Perjalanan';
const FIRST_POSITION = 'Quality Assurance';
const EDITED_POSITION = 'Senior Quality Assurance';
const FIRST_PHONE = '+62-813-0000-0001';
const EDITED_PHONE = '+62-813-0000-0002';

/** Shape every id the identity service writes has. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Copy for one key of the dictionary the employee app renders from. */
const employeeCopy = (key: EmployeeDictKey): string => employeeDictionary[key];

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

/**
 * One employee on the list, whichever layout the viewport is showing: a wide
 * screen gets a table row, a narrow one a stacked card, and both are always in
 * the document — so only the one on screen is ever counted.
 */
function employeeRow(page: Page, email: string): Locator {
  return page
    .locator(
      '[data-testid="karyawan-row"]:visible, [data-testid="karyawan-card"]:visible',
    )
    .filter({ hasText: email });
}

/** The row's own link into the edit screen of that record. */
function editLink(page: Page, email: string): Locator {
  return employeeRow(page, email).locator(
    'a[href*="/karyawan/"][href$="/edit"]',
  );
}

/** Addresses this run created; the cleanup below keys on them alone. */
const provisionedEmails: string[] = [];

/**
 * Drops the punch rows this run wrote, keyed to its own addresses. The
 * employee rows have no delete route in the console, so they stay behind.
 */
test.afterAll(() => {
  for (const email of provisionedEmails) {
    psql(
      `DELETE FROM attendance_sessions
         WHERE employee_id IN (SELECT id FROM employees WHERE email = '${email}')`,
    );
  }
});

test('one employee travels create, first change, punch, edit, reset, deactivation and a duplicate refusal', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000);

  const baseURL = testInfo.project.use.baseURL ?? 'http://localhost:8080';
  const viewport = testInfo.project.use.viewport ?? {
    width: 1280,
    height: 720,
  };

  // Three contexts because three different people act at once: the console
  // administrator, the employee who clears the first change, and a fresh
  // visitor who only ever tries to sign in. Each one opens the app through its
  // own sign-in screen, so no session is ever minted outside a real page.
  const hrdContext = await browser.newContext({
    baseURL,
    viewport,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const firstContext = await browser.newContext({ baseURL, viewport });
  const probeContext = await browser.newContext({ baseURL, viewport });

  let employeeId = '';
  let failure: unknown = null;

  try {
    // --- The console, entered through its own sign-in screen -------------
    const hrdPage = await hrdContext.newPage();
    // The console is mounted under /hrd; its bare prefix answers with a
    // directory redirect, so the journey opens the mounted address itself.
    await hrdPage.goto('/hrd/');
    await expect(hrdPage).toHaveURL(/\/hrd\/login$/);
    await expect(hrdPage.getByTestId('login')).toBeVisible();
    await expect(hrdPage.locator('h1')).toHaveText(hrdCopy('login.title'));
    await expect(hrdPage.getByTestId('shell-sign-out')).toHaveCount(0);

    const signIn = hrdPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/identity/auth/login'),
    );
    await hrdPage.locator('#login-email').fill(HRD_EMAIL);
    await hrdPage.locator('#login-password').fill(HRD_PASSWORD);
    await hrdPage.getByTestId('login-submit').click();

    const signInResponse = await signIn;
    expect(signInResponse.status(), 'the administrator must sign in').toBe(200);
    expect(await signInResponse.json()).toEqual({
      role: 'hrd',
      mustChangePassword: false,
    });
    await expect(hrdPage).toHaveURL(/\/hrd\/karyawan$/);
    await expect(hrdPage.getByTestId('karyawan-list')).toBeVisible();
    await expect(hrdPage.getByTestId('shell-sign-out')).toBeVisible();
    await expect(hrdPage.locator('header')).toContainText(
      hrdCopy('shell.appName'),
    );

    // --- Create ----------------------------------------------------------
    const email = `us4-crud-${crypto.randomUUID().slice(0, 12)}@example.com`;
    provisionedEmails.push(email);

    await hrdPage.getByTestId('karyawan-add-button').click();
    await expect(hrdPage).toHaveURL(/\/hrd\/karyawan\/add$/);
    await expect(hrdPage.getByTestId('employee-form')).toBeVisible();
    await expect(hrdPage.getByTestId('temp-password-preview')).toContainText(
      hrdCopy('karyawan.add.forcedChangeNote'),
    );

    // The address goes in last: the form clears its "already taken" notice
    // whenever the address is edited, so the notice must follow the submit.
    await hrdPage.locator('#employee-name').fill(EMPLOYEE_NAME);
    await hrdPage.locator('#employee-position').fill(FIRST_POSITION);
    await hrdPage.locator('#employee-phone').fill(FIRST_PHONE);
    await hrdPage.locator('#employee-email').fill(email);

    const created = hrdPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/identity/employees'),
    );
    await hrdPage.getByTestId('employee-form-submit').click();

    const createdResponse = await created;
    expect(createdResponse.status(), 'the save must create the account').toBe(
      201,
    );
    const createBody = createdResponse
      .request()
      .postDataJSON() as Record<string, unknown>;
    expect(createBody).toMatchObject({
      name: EMPLOYEE_NAME,
      email,
      position: FIRST_POSITION,
      phone: FIRST_PHONE,
    });
    expect(
      createBody,
      'the console never sends password material of any kind',
    ).not.toHaveProperty('temporaryPassword');
    expect(createBody).not.toHaveProperty('password');
    expect(createBody).not.toHaveProperty('mustChangePassword');

    const createdBody = (await createdResponse.json()) as {
      id?: string;
      temporaryPassword?: string;
    };
    employeeId = typeof createdBody.id === 'string' ? createdBody.id : '';
    expect(employeeId, 'the save must answer with the new id').toMatch(
      UUID_PATTERN,
    );
    const temporaryPassword =
      typeof createdBody.temporaryPassword === 'string'
        ? createdBody.temporaryPassword
        : '';
    expect(
      temporaryPassword,
      'the save must answer with a one-time password',
    ).not.toBe('');
    console.log(`[crud-journey] ${email} | ${employeeId}`);

    const revealed = hrdPage.getByTestId('temporary-password');
    await expect(revealed).toBeVisible();
    expect(
      (await revealed.innerText()).trim(),
      'the screen shows exactly what the API issued',
    ).toBe(temporaryPassword);
    await expect(hrdPage.getByTestId('karyawan-add')).toContainText(
      hrdCopy('karyawan.add.createdGuidance'),
    );
    await expect(hrdPage.getByTestId('success-toast')).toContainText(
      hrdCopy('toast.karyawan.created'),
    );

    await hrdPage.getByTestId('copy-password').click();
    await expect(hrdPage.getByTestId('copy-password')).toHaveText(
      hrdCopy('karyawan.add.createdCopied'),
    );

    await hrdPage.getByTestId('created-done').click();
    await expect(hrdPage).toHaveURL(/\/hrd\/karyawan$/);

    const createdRow = employeeRow(hrdPage, email);
    await expect(createdRow).toHaveCount(1);
    await expect(createdRow).toContainText(EMPLOYEE_NAME);
    await expect(createdRow).toContainText(FIRST_POSITION);
    await expect(createdRow.getByTestId('status-active')).toHaveCount(1);
    await expect(editLink(hrdPage, email)).toHaveCount(1);
    expect(
      await editLink(hrdPage, email).getAttribute('href'),
      'the row links back to the record the save made',
    ).toContain(employeeId);

    // --- The forced first change, in a second browser context ------------
    const employeePage = await firstContext.newPage();
    await employeePage.goto('/');
    await expect(employeePage.getByTestId('login')).toBeVisible();
    await expect(employeePage.locator('h1')).toHaveText(
      employeeCopy('login.title'),
    );

    const firstSignIn = employeePage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/identity/auth/login'),
    );
    await employeePage.locator('#login-email').fill(email);
    await employeePage.locator('#login-password').fill(temporaryPassword);
    await employeePage.getByTestId('login-submit').click();

    const firstSignInResponse = await firstSignIn;
    expect(
      firstSignInResponse.status(),
      'the one-time password must sign in',
    ).toBe(200);
    expect(await firstSignInResponse.json()).toEqual({
      role: 'employee',
      mustChangePassword: true,
    });

    // The temporary password owns every address until it is replaced.
    await expect(employeePage).toHaveURL(/\/first-login$/);
    await expect(employeePage.getByTestId('first-login')).toBeVisible();
    await expect(employeePage.getByTestId('first-login')).toContainText(
      employeeCopy('firstLogin.subtitle'),
    );
    await employeePage.goto('/absen');
    await expect(employeePage).toHaveURL(/\/first-login$/);
    await expect(employeePage.getByTestId('absen')).toHaveCount(0);
    await employeePage.goto('/summary');
    await expect(employeePage).toHaveURL(/\/first-login$/);
    await expect(employeePage.getByTestId('first-login')).toBeVisible();

    await employeePage
      .locator('#first-login-new-password')
      .fill(FIRST_CHOSEN_PASSWORD);
    await employeePage
      .locator('#first-login-confirm-password')
      .fill(FIRST_CHOSEN_PASSWORD);
    await employeePage.getByTestId('first-login-submit').click();
    await expect(employeePage).toHaveURL(/\/absen$/);
    await expect(employeePage.getByTestId('absen')).toBeVisible();

    // --- One punch: the account is a real one ----------------------------
    const punchStatus = employeePage.getByTestId('absen-status');
    await expect(punchStatus).toHaveText(
      employeeCopy('absen.status.belumMasuk'),
    );
    await expect(employeePage.getByTestId('punch-button')).toHaveText(
      employeeCopy('absen.punch.masuk'),
    );

    const punched = employeePage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/api/attendance/punches'),
    );
    await employeePage.getByTestId('punch-button').click();

    const punchResponse = await punched;
    expect(punchResponse.status(), 'the punch must be recorded').toBe(200);
    await expect(punchStatus).toHaveText(employeeCopy('absen.status.bekerja'));
    await expect(employeePage.getByTestId('absen-clock-in')).toBeVisible();
    await expect(employeePage.getByTestId('punch-button')).toHaveText(
      employeeCopy('absen.punch.pulang'),
    );

    // --- Edit ------------------------------------------------------------
    await editLink(hrdPage, email).click();
    await expect(hrdPage).toHaveURL(/\/hrd\/karyawan\/[0-9a-f-]+\/edit$/);
    await expect(hrdPage.getByTestId('employee-form')).toBeVisible();
    await expect(hrdPage.locator('#employee-name')).toHaveValue(EMPLOYEE_NAME);
    await expect(hrdPage.locator('#employee-email')).toHaveValue(email);
    await expect(hrdPage.locator('#employee-position')).toHaveValue(
      FIRST_POSITION,
    );
    // The phone column is not part of a list row, so the form opens with an
    // empty box whose own hint says an empty box means "keep it as it is".
    await expect(hrdPage.locator('#employee-phone')).toHaveValue('');

    await hrdPage.locator('#employee-position').fill(EDITED_POSITION);
    await hrdPage.locator('#employee-phone').fill(EDITED_PHONE);

    const saved = hrdPage.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes(`/api/identity/employees/${employeeId}`) &&
        !response.url().endsWith('/status'),
    );
    await hrdPage.getByTestId('employee-form-submit').click();

    const savedResponse = await saved;
    expect(savedResponse.status(), 'the edit must be accepted').toBe(200);
    expect(savedResponse.request().postDataJSON()).toMatchObject({
      name: EMPLOYEE_NAME,
      email,
      position: EDITED_POSITION,
      phone: EDITED_PHONE,
    });
    await expect(hrdPage.getByTestId('success-toast')).toContainText(
      hrdCopy('toast.karyawan.updated'),
    );

    await hrdPage.goto('/hrd/karyawan');
    const editedRow = employeeRow(hrdPage, email);
    await expect(editedRow).toHaveCount(1);
    await expect(editedRow).toContainText(EDITED_POSITION);

    // --- Reset -----------------------------------------------------------
    await editLink(hrdPage, email).click();
    await expect(hrdPage).toHaveURL(/\/hrd\/karyawan\/[0-9a-f-]+\/edit$/);
    await expect(hrdPage.getByTestId('status-card')).toBeVisible();
    await expect(hrdPage.getByTestId('password-card')).toBeVisible();
    await expect(hrdPage.getByTestId('temporary-password')).toHaveCount(0);

    const reset = hrdPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response
          .url()
          .endsWith(`/api/identity/employees/${employeeId}/reset-password`),
    );
    await hrdPage.getByTestId('reset-password').click();

    const resetResponse = await reset;
    expect(resetResponse.status(), 'the reset must be accepted').toBe(200);
    const resetBody = (await resetResponse.json()) as {
      temporaryPassword?: string;
    };
    const resetPassword =
      typeof resetBody.temporaryPassword === 'string'
        ? resetBody.temporaryPassword
        : '';
    expect(
      resetPassword,
      'the reset must answer with a one-time password',
    ).not.toBe('');

    const resetReveal = hrdPage.getByTestId('reset-reveal');
    await expect(resetReveal).toBeVisible();
    await expect(hrdPage.getByTestId('temporary-password')).toHaveText(
      resetPassword,
    );
    await expect(hrdPage.getByTestId('success-toast')).toContainText(
      hrdCopy('toast.karyawan.passwordReset'),
    );

    /** Applies the status radio that is on screen and waits for the answer. */
    const applyStatus = async (
      value: 'active' | 'deactivated',
    ): Promise<number> => {
      const answered = hrdPage.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          response
            .url()
            .endsWith(`/api/identity/employees/${employeeId}/status`),
      );
      await hrdPage
        .locator(`input[name="employee-status"][value="${value}"]`)
        .check();
      await hrdPage.getByTestId('status-apply').click();
      if (value === 'deactivated') {
        // Taking the account away signs the employee out, so the console
        // says so in full before it puts anything on the wire.
        const confirm = hrdPage.getByTestId('status-confirm');
        await expect(confirm).toBeVisible();
        await expect(confirm).toContainText(
          hrdCopy('karyawan.edit.statusConfirmTitle'),
        );
        await expect(confirm).toContainText(
          hrdCopy('karyawan.edit.statusConfirmBody'),
        );
        await hrdPage.getByTestId('status-confirm-yes').click();
      }
      return (await answered).status();
    };

    // --- The password that used to work does not any more ----------------
    // The account is still active here, so the only reason the previous
    // password is refused is the reset above.
    const probePage = await probeContext.newPage();
    await probePage.goto('/');
    await expect(probePage.getByTestId('login')).toBeVisible();

    const staleAttempt = probePage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/identity/auth/login'),
    );
    await probePage.locator('#login-email').fill(email);
    await probePage.locator('#login-password').fill(FIRST_CHOSEN_PASSWORD);
    await probePage.getByTestId('login-submit').click();

    const staleResponse = await staleAttempt;
    expect(
      staleResponse.status(),
      'the superseded password must be refused',
    ).toBe(401);
    expect(await staleResponse.json()).toMatchObject({
      statusCode: 401,
      code: 'AUTH_INVALID',
      attemptsRemaining: 4,
    });
    await expect(probePage).toHaveURL(/\/login$/);
    const staleError = probePage.getByTestId('login-error');
    await expect(staleError).toContainText(
      employeeCopy('login.error.invalid'),
    );
    await expect(probePage.getByTestId('login-attempts')).toHaveText(
      employeeCopy('login.error.attemptsRemaining').replace('{count}', '4'),
    );

    // --- Deactivate ------------------------------------------------------
    expect(
      await applyStatus('deactivated'),
      'the deactivation must be accepted',
    ).toBe(200);
    await expect(
      hrdPage.locator('input[name="employee-status"][value="deactivated"]'),
    ).toBeChecked();
    await expect(hrdPage.getByTestId('status-confirm')).toHaveCount(0);
    await expect(hrdPage.getByTestId('success-toast')).toContainText(
      hrdCopy('toast.karyawan.statusChanged'),
    );

    await hrdPage.goto('/hrd/karyawan');
    await expect(
      employeeRow(hrdPage, email).getByTestId('status-deactivated'),
    ).toHaveCount(1);

    // --- A deactivated account cannot sign in ----------------------------
    const deactivatedAttempt = probePage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/identity/auth/login'),
    );
    await probePage.locator('#login-password').fill(resetPassword);
    await probePage.getByTestId('login-submit').click();

    const deactivatedResponse = await deactivatedAttempt;
    expect(
      deactivatedResponse.status(),
      'a deactivated account must be refused',
    ).toBe(401);
    expect(await deactivatedResponse.json()).toMatchObject({
      statusCode: 401,
      code: 'AUTH_INVALID',
      attemptsRemaining: 3,
    });
    await expect(probePage).toHaveURL(/\/login$/);
    await expect(probePage.getByTestId('login-error')).toContainText(
      employeeCopy('login.error.invalid'),
    );
    await expect(probePage.getByTestId('login-attempts')).toHaveText(
      employeeCopy('login.error.attemptsRemaining').replace('{count}', '3'),
    );

    // --- Reactivate ------------------------------------------------------
    await editLink(hrdPage, email).click();
    await expect(hrdPage).toHaveURL(/\/hrd\/karyawan\/[0-9a-f-]+\/edit$/);
    expect(
      await applyStatus('active'),
      'the activation must be accepted',
    ).toBe(200);
    // Bringing the account back is not destructive, so nothing asks twice.
    await expect(hrdPage.getByTestId('status-confirm')).toHaveCount(0);
    await expect(
      hrdPage.locator('input[name="employee-status"][value="active"]'),
    ).toBeChecked();
    await expect(hrdPage.getByTestId('success-toast')).toContainText(
      hrdCopy('toast.karyawan.statusChanged'),
    );

    // --- The account works again, with the reset password ----------------
    const revivedAttempt = probePage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/identity/auth/login'),
    );
    await probePage.getByTestId('login-submit').click();

    const revivedResponse = await revivedAttempt;
    expect(
      revivedResponse.status(),
      'the activated account must sign in again',
    ).toBe(200);
    expect(await revivedResponse.json()).toEqual({
      role: 'employee',
      mustChangePassword: true,
    });
    await expect(probePage).toHaveURL(/\/first-login$/);
    await expect(probePage.getByTestId('first-login')).toBeVisible();

    await probePage
      .locator('#first-login-new-password')
      .fill(AFTER_RESET_PASSWORD);
    await probePage
      .locator('#first-login-confirm-password')
      .fill(AFTER_RESET_PASSWORD);
    await probePage.getByTestId('first-login-submit').click();
    await expect(probePage).toHaveURL(/\/absen$/);

    // Deactivation closed the punch that was still open, so the screen the
    // employee comes back to has to offer a clock-in again.
    await expect(probePage.getByTestId('absen-status')).toHaveText(
      employeeCopy('absen.status.belumMasuk'),
    );
    await expect(probePage.getByTestId('punch-button')).toHaveText(
      employeeCopy('absen.punch.masuk'),
    );
    expect(
      psql(
        `SELECT closed_by_system FROM attendance_sessions
           WHERE employee_id = '${employeeId}'`,
      ),
      'the deactivation closed the open punch with a system marker',
    ).toBe('t');

    // --- A second account on the same address is refused -----------------
    await hrdPage.goto('/hrd/karyawan/add');
    await expect(hrdPage.getByTestId('employee-form')).toBeVisible();
    await hrdPage.locator('#employee-name').fill(EMPLOYEE_NAME);
    await hrdPage.locator('#employee-position').fill(FIRST_POSITION);
    await hrdPage.locator('#employee-phone').fill(FIRST_PHONE);
    await hrdPage.locator('#employee-email').fill(email);

    const duplicate = hrdPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/identity/employees'),
    );
    await hrdPage.getByTestId('employee-form-submit').click();

    const duplicateResponse = await duplicate;
    expect(
      duplicateResponse.status(),
      'a second account on one address must be refused',
    ).toBe(409);
    const duplicateBody = await duplicateResponse.json();
    expect(duplicateBody).toMatchObject({
      statusCode: 409,
      code: 'EMAIL_TAKEN',
    });
    expect(
      duplicateBody,
      'a refused save issues no password',
    ).not.toHaveProperty('temporaryPassword');
    await expect(hrdPage).toHaveURL(/\/hrd\/karyawan\/add$/);
    await expect(hrdPage.getByTestId('employee-form')).toBeVisible();
    await expect(hrdPage.getByTestId('error-email')).toHaveText(
      hrdCopy('form.error.emailTaken'),
    );
    await expect(hrdPage.getByTestId('temporary-password')).toHaveCount(0);

    // --- The record survived all of it ------------------------------------
    await hrdPage.goto('/hrd/karyawan');
    const finalRow = employeeRow(hrdPage, email);
    await expect(finalRow).toHaveCount(1);
    await expect(finalRow).toContainText(EMPLOYEE_NAME);
    await expect(finalRow).toContainText(email);
    await expect(finalRow).toContainText(EDITED_POSITION);
    await expect(finalRow.getByTestId('status-active')).toHaveCount(1);
    expect(
      await editLink(hrdPage, email).getAttribute('href'),
      'the same record is still the one the journey created',
    ).toContain(employeeId);

    // --- Leave the fixture account deactivated ---------------------------
    await editLink(hrdPage, email).click();
    await expect(hrdPage).toHaveURL(/\/hrd\/karyawan\/[0-9a-f-]+\/edit$/);
    expect(await applyStatus('deactivated')).toBe(200);
    await expect(
      hrdPage.locator('input[name="employee-status"][value="deactivated"]'),
    ).toBeChecked();

    // --- Sign out through the console's own control ----------------------
    await hrdPage.goto('/hrd/karyawan');
    await hrdPage.getByTestId('shell-sign-out').click();
    await expect(hrdPage).toHaveURL(/\/hrd\/login$/);
    await expect(hrdPage.getByTestId('login')).toBeVisible();
    await expect(hrdPage.getByTestId('shell-sign-out')).toHaveCount(0);
  } catch (error) {
    failure = error;
  }

  // Whatever went wrong above, the run leaves the stack the way it found it:
  // the fixture account is deactivated (which drops its sessions as well) and
  // the administrator's session is ended. Both calls answer 401 when the
  // happy path already did this, and that is not a problem.
  if (employeeId !== '') {
    const left = await hrdContext.request
      .patch(`${baseURL}/api/identity/employees/${employeeId}/status`, {
        data: { status: 'deactivated' },
      })
      .catch(() => null);
    if (left !== null && left.status() !== 200 && left.status() !== 401) {
      console.error(
        `[crud-journey] leaving the account deactivated answered ${left.status()}`,
      );
    }
  }
  await hrdContext.request
    .post(`${baseURL}/api/identity/auth/logout`)
    .catch(() => undefined);
  await Promise.all(
    [hrdContext, firstContext, probeContext].map(async (context) => {
      try {
        await context.close();
      } catch {
        // A context the browser already dropped needs no closing.
      }
    }),
  );

  if (failure !== null) {
    throw failure;
  }
});
