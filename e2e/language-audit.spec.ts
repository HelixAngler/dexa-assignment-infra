import { execFileSync } from 'node:child_process';

import argon2 from 'argon2';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { en as employeeEnglish } from '../../employee-web/src/i18n/en';
import {
  id as employeeIndonesian,
  type DictKey as EmployeeDictKey,
} from '../../employee-web/src/i18n/id';
import { en as hrdEnglish } from '../../hrd-web/src/i18n/en';
import {
  id as hrdIndonesian,
  type DictKey as HrdDictKey,
} from '../../hrd-web/src/i18n/id';

/**
 * Language switching, screen by screen, on both apps of the running stack.
 *
 * Every screen below is opened the way a person opens it — through the real
 * sign-in screen, with an account that belongs to this run — and is then put
 * through one cycle: it must render in Indonesian first, the switch must move
 * every watched element to its English copy straight away, nothing the switch
 * just replaced may be left showing the Indonesian wording, the switch itself
 * must not put a single session request on the wire, and a reload has to keep
 * both the language and the signed-in state. Each screen ends back on the
 * product default so the next one opens in Indonesian again.
 *
 * The watched elements are picked per screen: the screen's own heading plus
 * two stable elements (a testid or an attribute) whose Indonesian and English
 * dictionary entries differ, so a swap is observable. Every expected string
 * is read out of the two language files of the app being checked; nothing is
 * written down here by hand.
 *
 * The accounts are the run's own: one employee and one console operator, both
 * created with a temporary password and the flag that forces a change, which
 * is what makes the forced first-password screen reachable at all. The two
 * access-denied screens are the only ones that need somebody else's session,
 * so they are reached by signing the seeded demo accounts in and straight back
 * out without touching anything they own. All three rows this run creates are
 * deleted again when the run reports.
 */

/** Compose project the stack runs under; used to reach its containers. */
const COMPOSE_PROJECT = 'infra';
const DB_USER = 'wfh';
const DB_NAME = 'wfh_main';

/** Password both of this run's accounts open with. */
const TEMPORARY_PASSWORD = 'Language-Audit-Temp!2026';

/** Password the forced first change replaces it with, mid run. */
const CHOSEN_PASSWORD = 'Language-Audit-Chosen!2026';

/** Seeded accounts; only ever signed in and out, never written. */
const HRD_EMAIL = 'ivan@company.com';
const HRD_PASSWORD = 'HrdAdmin!2026';
const EMPLOYEE_EMAIL = 'ada@company.com';
const EMPLOYEE_PASSWORD = 'EmployeeDemo!2026';

/** Names this run's two accounts are created with; the copy audits key on them. */
const EMPLOYEE_NAME = 'Toggle Probe Employee';
const CONSOLE_NAME = 'Toggle Probe Console';

/** Shape every id the identity service writes has. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Settling time after a switch, long enough for a stray request to show up. */
const TOGGLE_SETTLE_MS = 250;

/** `localStorage` key both apps keep the chosen language under. */
const LANGUAGE_STORAGE_KEY = 'lang';

/**
 * Session-shaped calls the page being audited put on the wire. The suite runs
 * one worker at a time, so the whole file shares this list and every switch
 * empties it before it clicks anything.
 */
const sessionTraffic: string[] = [];

/** Copy for one key of one app's Indonesian dictionary. */
function indonesianCopy<K extends string>(
  dictionary: Readonly<Record<K, string>>,
  key: K,
): string {
  const copy = dictionary[key];
  if (typeof copy !== 'string' || copy === '') {
    throw new Error(`the dictionary holds no copy for "${String(key)}"`);
  }
  return copy;
}

/** One dictionary-backed element the audit watches on a screen. */
interface Probe<K extends string> {
  /** Language-independent selector for the element inside the screen root. */
  selector: string;
  /** Dictionary key the element renders its copy from. */
  key: K;
  /** Attribute carrying the copy, when it is not the element's own text. */
  attribute?: string;
  /** The element holds more than the copy, so the copy is matched inside it. */
  contains?: boolean;
  /** Take the first match only, for elements the layout renders more than once. */
  first?: boolean;
}

/** A screen of one app: its root plus the elements watched on it. */
interface Screen<K extends string> {
  /** Appears in every assertion message, so a failure names its screen. */
  name: string;
  /** Element that scopes the screen; the "nothing Indonesian left" check uses it. */
  root: string;
  /** The heading plus two stable labels, as chosen for this screen. */
  probes: Probe<K>[];
}

/** Resolves one probe inside the screen root, honouring its first-match flag. */
function probeTarget<K extends string>(root: Locator, probe: Probe<K>): Locator {
  const target = root.locator(probe.selector);
  return probe.first === true ? target.first() : target;
}

/**
 * Walks one screen through the whole cycle: Indonesian copy first, then the
 * switch with the session traffic counted while it happens, then the check
 * that nothing replaced is still Indonesian, then a reload that has to keep
 * both the language and the screen, and finally the switch back so the next
 * screen opens in Indonesian again.
 */
async function auditScreen<K extends string>(
  page: Page,
  screen: Screen<K>,
  indonesian: Readonly<Record<K, string>>,
  english: Readonly<Record<K, string>>,
  switchLabelKey: K,
): Promise<void> {
  const root = page.locator(screen.root);
  const toggle = page.locator('[data-testid="lang-toggle"]:visible');

  await expect(root, `${screen.name}: the screen must be open`).toBeVisible();
  await expect(
    toggle,
    `${screen.name}: exactly one language switch must be on screen`,
  ).toHaveCount(1);

  const expectCopy = async (
    dictionary: Readonly<Record<K, string>>,
    language: string,
  ): Promise<void> => {
    for (const probe of screen.probes) {
      const expected = indonesianCopy(dictionary, probe.key);
      const target = probeTarget(root, probe);
      const where = `${screen.name}: ${probe.key} must read ${language}`;
      if (probe.attribute !== undefined) {
        await expect(target, where).toHaveAttribute(probe.attribute, expected);
      } else if (probe.contains === true) {
        await expect(target, where).toContainText(expected);
      } else {
        await expect(target, where).toHaveText(expected);
      }
    }
    // The switch labels the language it jumps to, so it moves with the rest.
    await expect(
      toggle,
      `${screen.name}: the switch must name the language it offers`,
    ).toHaveAttribute('aria-label', indonesianCopy(dictionary, switchLabelKey));
  };

  // 1. The screen as it opens: every watched element carries its Indonesian copy.
  await expectCopy(indonesian, 'Indonesian');

  // 2. One click moves the screen to English without touching the session:
  //    no sign-in, no sign-out, no password call and no session probe.
  sessionTraffic.length = 0;
  await toggle.click();
  await expectCopy(english, 'English');
  await page.waitForTimeout(TOGGLE_SETTLE_MS);
  expect(
    sessionTraffic,
    `${screen.name}: switching the language must not reach the session`,
  ).toEqual([]);

  // 3. Nothing that was just translated is left showing the Indonesian wording.
  for (const probe of screen.probes) {
    const before = indonesianCopy(indonesian, probe.key);
    if (probe.attribute !== undefined) {
      expect(
        await probeTarget(root, probe).getAttribute(probe.attribute),
        `${screen.name}: ${probe.key} must not keep its Indonesian copy`,
      ).not.toBe(before);
      continue;
    }
    if (before === indonesianCopy(english, probe.key)) {
      continue;
    }
    expect(
      (await root.textContent()) ?? '',
      `${screen.name} must not show "${before}" once English is selected`,
    ).not.toContain(before);
  }

  // 4. A reload keeps the choice in storage and leaves the screen where it was:
  //    an expired or broken session would have thrown this screen out.
  const beforeReload = page.url();
  await page.reload();
  await expect(root, `${screen.name}: still open after the reload`).toBeVisible();
  expect(
    page.url(),
    `${screen.name}: the reload must not move the screen`,
  ).toBe(beforeReload);
  expect(
    await storedLanguage(page),
    `${screen.name}: the language survives a reload`,
  ).toBe('en');
  await expectCopy(english, 'English after the reload');

  // 5. Back to the product default, so the next screen starts from Indonesian
  //    and the run leaves the browser where it found it.
  await toggle.click();
  await expectCopy(indonesian, 'Indonesian again');
  expect(await storedLanguage(page), `${screen.name}: the switch back`).toBe('id');

  console.log(
    `[language-audit] ${screen.name}: id -> en -> reload keeps en -> back to id`,
  );
}

/** The language the page kept in its own storage, or `null` when it kept none. */
function storedLanguage(page: Page): Promise<string | null> {
  return page.evaluate<string | null>(`localStorage.getItem("${LANGUAGE_STORAGE_KEY}")`);
}

/**
 * Counts the session-shaped requests one page sends: every sign-in, sign-out
 * and password call under `/auth/`, plus the profile probe the apps use to
 * learn who is signed in. Requests are counted and then waved straight
 * through, so the page behaves exactly as it would without the watch.
 */
async function watchSessionTraffic(page: Page): Promise<void> {
  const note = (request: { method(): string; url(): string }): void => {
    sessionTraffic.push(`${request.method()} ${new URL(request.url()).pathname}`);
  };
  await page.route('**/auth/**', async (route) => {
    note(route.request());
    await route.continue();
  });
  await page.route('**/api/identity/profile', async (route) => {
    note(route.request());
    await route.continue();
  });
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

/**
 * Hashes a password the way the sign-in path verifies it: the same argon2id
 * flavour with the same cost parameters, so an account row written from here
 * is an ordinary one and the real sign-in code accepts it unchanged.
 */
const hashForSignIn = async (password: string): Promise<string> =>
  argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

/** Accounts this run wrote; the cleanup below keys on their addresses alone. */
const provisionedEmails: string[] = [];

/**
 * Drops the three rows this run created, keyed to its own addresses. People
 * go last: both tables pointing at them hold their key with a restrict rule.
 */
test.afterAll(() => {
  for (const email of provisionedEmails) {
    psql(
      `DELETE FROM profile_change_events
         WHERE employee_id IN (SELECT id FROM employees WHERE email = '${email}');
       DELETE FROM attendance_sessions
         WHERE employee_id IN (SELECT id FROM employees WHERE email = '${email}');
       DELETE FROM employees WHERE email = '${email}'`,
    );
  }
});

/**
 * Writes one account of this run straight into the main database: an ordinary
 * row carrying a temporary password hashed with the parameters the sign-in
 * path itself uses, and the flag that makes the forced first-password screen
 * the only screen the account can reach until the change is saved.
 */
async function provisionAccount(input: {
  name: string;
  email: string;
  role: 'employee' | 'hrd';
  phone: string;
}): Promise<string> {
  const hash = await hashForSignIn(TEMPORARY_PASSWORD);
  // Wrapped in a select so the command answer is the id alone: a bare
  // `INSERT … RETURNING` would append its own command tag to the output and
  // the check below would no longer be looking at an id at all.
  const id = psql(
    `WITH created AS (
       INSERT INTO employees
         (name, email, position, phone, status, role, password_hash, must_change_password, auth_provider)
       VALUES
         ('${input.name}', '${input.email}', 'Toggle Tester', '${input.phone}',
          'active', '${input.role}', '${hash}', true, 'local')
       RETURNING id
     )
     SELECT id FROM created`,
  );
  expect(id, `${input.email}: the account must be written`).toMatch(
    UUID_PATTERN,
  );
  provisionedEmails.push(input.email);
  return id;
}

/** The employee app screens, each with the heading and two labels it watches. */
const EMPLOYEE_LOGIN: Screen<EmployeeDictKey> = {
  name: 'employee sign-in',
  root: '[data-testid="login"]',
  probes: [
    { selector: 'h1', key: 'login.title' },
    { selector: '[data-testid="login-submit"]', key: 'login.submit' },
    { selector: 'label[for="login-password"]', key: 'login.passwordLabel' },
  ],
};

const EMPLOYEE_FIRST_LOGIN: Screen<EmployeeDictKey> = {
  name: 'employee forced first password change',
  root: '[data-testid="first-login"]',
  probes: [
    { selector: 'h1', key: 'firstLogin.title' },
    { selector: '#first-login-hint', key: 'firstLogin.hint' },
    { selector: '[data-testid="first-login-submit"]', key: 'firstLogin.submit' },
  ],
};

const EMPLOYEE_ABSEN: Screen<EmployeeDictKey> = {
  name: 'employee attendance',
  root: '[data-testid="absen"]',
  probes: [
    { selector: 'h1', key: 'absen.title' },
    { selector: '[data-testid="absen-status"]', key: 'absen.status.belumMasuk' },
    { selector: '[data-testid="punch-button"]', key: 'absen.punch.masuk' },
  ],
};

const EMPLOYEE_SUMMARY: Screen<EmployeeDictKey> = {
  name: 'employee summary',
  root: '[data-testid="summary"]',
  probes: [
    { selector: 'h1', key: 'summary.title' },
    { selector: 'label[for="summary-range-from"]', key: 'summary.filter.fromLabel' },
    { selector: '[data-testid="summary-search"]', key: 'summary.filter.search' },
  ],
};

const EMPLOYEE_PROFIL: Screen<EmployeeDictKey> = {
  name: 'employee profile',
  root: '[data-testid="profil"]',
  probes: [
    { selector: 'h1', key: 'profile.title' },
    {
      selector: 'a[href="/profil/telepon"]',
      key: 'profile.phone.edit',
      attribute: 'aria-label',
    },
    {
      selector: 'a[href="/profil/kata-sandi"]',
      key: 'profile.password.edit',
      attribute: 'aria-label',
    },
  ],
};

const EMPLOYEE_CHANGE_PHONE: Screen<EmployeeDictKey> = {
  name: 'employee change phone',
  root: '[data-testid="change-phone"]',
  probes: [
    { selector: 'h1', key: 'profile.phone.title' },
    { selector: '[data-testid="phone-save"]', key: 'common.save' },
    { selector: '[data-testid="phone-cancel"]', key: 'common.cancel' },
  ],
};

const EMPLOYEE_CHANGE_PHOTO: Screen<EmployeeDictKey> = {
  name: 'employee change photo',
  root: '[data-testid="change-photo"]',
  probes: [
    { selector: 'h1', key: 'profile.photo.title' },
    { selector: '[data-testid="photo-rules"]', key: 'profile.photo.hint' },
    { selector: '[data-testid="photo-cancel"]', key: 'common.cancel' },
  ],
};

const EMPLOYEE_CHANGE_PASSWORD: Screen<EmployeeDictKey> = {
  name: 'employee change password',
  root: '[data-testid="change-password"]',
  probes: [
    { selector: 'h1', key: 'profile.password.title' },
    { selector: '[data-testid="password-note"]', key: 'profile.password.note' },
    { selector: '[data-testid="password-save"]', key: 'common.save' },
  ],
};

const EMPLOYEE_ACCESS_DENIED: Screen<EmployeeDictKey> = {
  name: 'employee access denied',
  root: '[data-testid="access-denied-state"]',
  probes: [
    { selector: 'h2', key: 'state.accessDenied.title' },
    { selector: 'p', key: 'state.accessDenied.description' },
    { selector: '[data-testid="sign-out-button"]', key: 'state.accessDenied.signOut' },
  ],
};

/** The console screens, each with the heading and two labels it watches. */
const HRD_LOGIN: Screen<HrdDictKey> = {
  name: 'console sign-in',
  root: '[data-testid="login"]',
  probes: [
    { selector: 'h1', key: 'login.title' },
    { selector: 'h1 + p', key: 'login.subtitle' },
    { selector: '[data-testid="login-submit"]', key: 'login.submit' },
  ],
};

const HRD_FIRST_LOGIN: Screen<HrdDictKey> = {
  name: 'console forced first password change',
  root: '[data-testid="first-login"]',
  probes: [
    { selector: 'h1', key: 'firstLogin.title' },
    { selector: '#first-login-hint', key: 'firstLogin.hint' },
    { selector: '[data-testid="first-login-submit"]', key: 'firstLogin.submit' },
  ],
};

const HRD_KARYAWAN_LIST: Screen<HrdDictKey> = {
  name: 'console employee list',
  root: '[data-testid="karyawan-list"]',
  probes: [
    { selector: 'h1', key: 'karyawan.list.title' },
    { selector: '[data-testid="karyawan-add-button"]', key: 'karyawan.list.add' },
    {
      // The list renders one status pill per row in a wide table and again in
      // the narrow card stack, so only the pill that is on screen is read.
      selector: '[data-testid="status-active"]:visible',
      key: 'karyawan.status.active',
      first: true,
    },
  ],
};

const HRD_KARYAWAN_ADD: Screen<HrdDictKey> = {
  name: 'console add employee',
  root: '[data-testid="karyawan-add"]',
  probes: [
    { selector: 'h1', key: 'karyawan.add.title' },
    { selector: '[data-testid="employee-form-submit"]', key: 'form.submit.add' },
    {
      selector: '[data-testid="temp-password-preview"]',
      key: 'karyawan.add.forcedChangeNote',
      contains: true,
    },
  ],
};

const HRD_KARYAWAN_EDIT: Screen<HrdDictKey> = {
  name: 'console edit employee',
  root: '[data-testid="karyawan-edit"]',
  probes: [
    { selector: 'h1', key: 'karyawan.edit.title' },
    { selector: '[data-testid="status-apply"]', key: 'karyawan.edit.statusApply' },
    { selector: '[data-testid="reset-password"]', key: 'karyawan.edit.resetAction' },
  ],
};

const HRD_ABSENSI: Screen<HrdDictKey> = {
  name: 'console attendance',
  root: '[data-testid="absensi"]',
  probes: [
    { selector: 'h1', key: 'absensi.title' },
    { selector: '[data-testid="absensi-readonly"]', key: 'absensi.readOnlyNote' },
    { selector: '[data-testid="absensi-search-submit"]', key: 'absensi.searchSubmit' },
  ],
};

const HRD_ACCESS_DENIED: Screen<HrdDictKey> = {
  name: 'console access denied',
  root: '[data-testid="access-denied-state"]',
  probes: [
    { selector: 'h2', key: 'route.denied.employeeTitle' },
    { selector: 'p', key: 'route.denied.employeeDescription' },
    { selector: '[data-testid="sign-out-button"]', key: 'state.accessDenied.signOut' },
  ],
};

test('every employee screen switches language in place and keeps its session', async ({
  browser,
}, testInfo) => {
  test.setTimeout(600_000);

  const baseURL = testInfo.project.use.baseURL ?? 'http://localhost:8080';
  const viewport = testInfo.project.use.viewport ?? { width: 1280, height: 720 };
  const context = await browser.newContext({ baseURL, viewport });

  let failure: unknown = null;

  try {
    // --- The account this run owns, written straight into the database ----
    const email = `lang-audit-emp-${crypto.randomUUID().slice(0, 12)}@example.com`;
    await provisionAccount({
      name: EMPLOYEE_NAME,
      email,
      role: 'employee',
      phone: '+62-817-0000-0007',
    });

    const page = await context.newPage();
    await watchSessionTraffic(page);

    // --- Sign-in: reached anonymously, so the screen starts in Indonesian --
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await auditScreen(
      page,
      EMPLOYEE_LOGIN,
      employeeIndonesian,
      employeeEnglish,
      'shell.toggleLanguage',
    );

    await page.locator('#login-email').fill(email);
    await page.locator('#login-password').fill(TEMPORARY_PASSWORD);
    const signedIn = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/identity/auth/login'),
    );
    await page.getByTestId('login-submit').click();
    expect((await signedIn).status(), 'the temporary password must sign in').toBe(200);
    await expect(page).toHaveURL(/\/first-login$/);

    // --- The forced first change owns every address until it is saved -----
    await auditScreen(
      page,
      EMPLOYEE_FIRST_LOGIN,
      employeeIndonesian,
      employeeEnglish,
      'shell.toggleLanguage',
    );

    await page.locator('#first-login-new-password').fill(CHOSEN_PASSWORD);
    await page.locator('#first-login-confirm-password').fill(CHOSEN_PASSWORD);
    await page.getByTestId('first-login-submit').click();
    await expect(page).toHaveURL(/\/absen$/);

    // --- The screens behind the sign-in -----------------------------------
    await expect(page.getByTestId('absen-status')).toBeVisible();
    await auditScreen(
      page,
      EMPLOYEE_ABSEN,
      employeeIndonesian,
      employeeEnglish,
      'shell.toggleLanguage',
    );

    const summaryLoad = page.waitForResponse((response) =>
      response.url().includes('/api/attendance/summary'),
    );
    await page.goto('/summary');
    expect((await summaryLoad).status(), 'the summary must answer').toBe(200);
    await auditScreen(
      page,
      EMPLOYEE_SUMMARY,
      employeeIndonesian,
      employeeEnglish,
      'shell.toggleLanguage',
    );

    await page.goto('/profil');
    await expect(page.getByTestId('profil-name')).toHaveText(EMPLOYEE_NAME);
    await auditScreen(
      page,
      EMPLOYEE_PROFIL,
      employeeIndonesian,
      employeeEnglish,
      'shell.toggleLanguage',
    );

    for (const [path, screen] of [
      ['/profil/telepon', EMPLOYEE_CHANGE_PHONE],
      ['/profil/foto', EMPLOYEE_CHANGE_PHOTO],
      ['/profil/kata-sandi', EMPLOYEE_CHANGE_PASSWORD],
    ] as const) {
      await page.goto(path);
      await expect(page.locator(screen.root)).toBeVisible();
      await auditScreen(
        page,
        screen,
        employeeIndonesian,
        employeeEnglish,
        'shell.toggleLanguage',
      );
    }

    // --- The employee screens offer no sign-out control of their own, so
    //     the session is ended through the same endpoint the app itself uses.
    await context.request.post(`${baseURL}/api/identity/auth/logout`);

    // --- A console session has no place in the employee app ---------------
    await page.goto('/');
    await expect(page.getByTestId('login')).toBeVisible();
    const consoleSignIn = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/identity/auth/login'),
    );
    await page.locator('#login-email').fill(HRD_EMAIL);
    await page.locator('#login-password').fill(HRD_PASSWORD);
    await page.getByTestId('login-submit').click();
    expect((await consoleSignIn).status()).toBe(200);
    await expect(page.getByTestId('access-denied-state')).toBeVisible();

    await auditScreen(
      page,
      EMPLOYEE_ACCESS_DENIED,
      employeeIndonesian,
      employeeEnglish,
      'shell.toggleLanguage',
    );

    // The screen offers the only sign-out the employee app has; use it, so
    // the run leaves the browser anonymous instead of holding a session.
    await page.getByTestId('sign-out-button').click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('login')).toBeVisible();
  } catch (error) {
    failure = error;
  }

  // Whatever went wrong above, the run does not keep a session behind it.
  await context.request
    .post(`${baseURL}/api/identity/auth/logout`)
    .catch(() => undefined);
  await context.close().catch(() => undefined);

  if (failure !== null) {
    throw failure;
  }
});

test('every console screen switches language in place and keeps its session', async ({
  browser,
}, testInfo) => {
  test.setTimeout(600_000);

  const baseURL = testInfo.project.use.baseURL ?? 'http://localhost:8080';
  const viewport = testInfo.project.use.viewport ?? { width: 1280, height: 720 };
  const context = await browser.newContext({ baseURL, viewport });

  let failure: unknown = null;

  try {
    // --- The console account this run owns --------------------------------
    const email = `lang-audit-hrd-${crypto.randomUUID().slice(0, 12)}@example.com`;
    const employeeId = await provisionAccount({
      name: CONSOLE_NAME,
      email,
      role: 'hrd',
      phone: '+62-817-0000-0008',
    });

    const page = await context.newPage();
    await watchSessionTraffic(page);

    // --- Sign-in: reached anonymously, so the screen starts in Indonesian --
    await page.goto('/hrd/');
    await expect(page).toHaveURL(/\/hrd\/login$/);
    await auditScreen(
      page,
      HRD_LOGIN,
      hrdIndonesian,
      hrdEnglish,
      'shell.toggleLanguage',
    );

    await page.locator('#login-email').fill(email);
    await page.locator('#login-password').fill(TEMPORARY_PASSWORD);
    const signedIn = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/identity/auth/login'),
    );
    await page.getByTestId('login-submit').click();
    expect((await signedIn).status(), 'the temporary password must sign in').toBe(200);
    await expect(page).toHaveURL(/\/hrd\/first-login$/);

    // --- The forced first change owns every address until it is saved -----
    await auditScreen(
      page,
      HRD_FIRST_LOGIN,
      hrdIndonesian,
      hrdEnglish,
      'shell.toggleLanguage',
    );

    await page.locator('#first-login-new-password').fill(CHOSEN_PASSWORD);
    await page.locator('#first-login-confirm-password').fill(CHOSEN_PASSWORD);
    await page.getByTestId('first-login-submit').click();
    await expect(page).toHaveURL(/\/hrd\/karyawan$/);

    // --- The console behind the sign-in -----------------------------------
    await expect(
      page
        .locator(
          '[data-testid="karyawan-row"]:visible, [data-testid="karyawan-card"]:visible',
        )
        .first(),
      'the directory must list somebody before it is audited',
    ).toBeVisible();
    await auditScreen(
      page,
      HRD_KARYAWAN_LIST,
      hrdIndonesian,
      hrdEnglish,
      'shell.toggleLanguage',
    );

    await page.goto('/hrd/karyawan/add');
    await expect(page.getByTestId('employee-form')).toBeVisible();
    await auditScreen(
      page,
      HRD_KARYAWAN_ADD,
      hrdIndonesian,
      hrdEnglish,
      'shell.toggleLanguage',
    );

    // The record this run just created is the one opened for editing, so the
    // audit reads its own row and no seeded account is ever opened for change.
    const editLoad = page.waitForResponse((response) =>
      response.url().endsWith('/api/identity/employees'),
    );
    await page.goto(`/hrd/karyawan/${employeeId}/edit`);
    await editLoad;
    await expect(page.getByTestId('status-apply')).toBeVisible();
    await auditScreen(
      page,
      HRD_KARYAWAN_EDIT,
      hrdIndonesian,
      hrdEnglish,
      'shell.toggleLanguage',
    );

    const attendanceLoad = page.waitForResponse((response) =>
      response.url().includes('/api/attendance/attendance'),
    );
    await page.goto('/hrd/absensi');
    expect((await attendanceLoad).status(), 'the day view must answer').toBe(200);
    await auditScreen(
      page,
      HRD_ABSENSI,
      hrdIndonesian,
      hrdEnglish,
      'shell.toggleLanguage',
    );

    // --- Sign out through the console's own control ------------------------
    await page.getByTestId('shell-sign-out').click();
    await expect(page).toHaveURL(/\/hrd\/login$/);
    await expect(page.getByTestId('login')).toBeVisible();

    // --- An employee session is denied the console -------------------------
    const employeeSignIn = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/identity/auth/login'),
    );
    await page.locator('#login-email').fill(EMPLOYEE_EMAIL);
    await page.locator('#login-password').fill(EMPLOYEE_PASSWORD);
    await page.getByTestId('login-submit').click();
    expect((await employeeSignIn).status()).toBe(200);
    await expect(page.getByTestId('access-denied-state')).toBeVisible();

    await auditScreen(
      page,
      HRD_ACCESS_DENIED,
      hrdIndonesian,
      hrdEnglish,
      'shell.toggleLanguage',
    );

    // The screen's own sign-out leaves the console anonymous again.
    await page.getByTestId('sign-out-button').click();
    await expect(page).toHaveURL(/\/hrd\/login$/);
    await expect(page.getByTestId('login')).toBeVisible();
  } catch (error) {
    failure = error;
  }

  // Whatever went wrong above, the run does not keep a session behind it.
  await context.request
    .post(`${baseURL}/api/identity/auth/logout`)
    .catch(() => undefined);
  await context.close().catch(() => undefined);

  if (failure !== null) {
    throw failure;
  }
});
