import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { PrismaClient } from '../../identity-service/src/generated/prisma';
import { en as englishDictionary } from '../../hrd-web/src/i18n/en';
import {
  id as indonesianDictionary,
  type DictKey,
} from '../../hrd-web/src/i18n/id';

/**
 * Maker-checker journeys against the running dev stack: adding an HR account
 * from end to end, the API refusal answers, and deactivating an HR account.
 * Two browser sessions share one console page each: the maker (ivan) proposes
 * HR accounts, the peer (hr-checker fixture) decides them. The console only
 * trusts a sign-in performed through its own form — an API-minted cookie
 * carries no identity the shell can resolve — so every UI session logs in via
 * the page, while the refusal checks talk to the API directly with a request
 * context.
 *
 * The journeys create their own proposal rows and throwaway HR accounts and
 * remove them again (there is no delete route in the console, so this test
 * reaches into the main database directly); the seeded demo accounts are
 * never mutated.
 */

const MAKER_EMAIL = 'ivan@company.com';
const MAKER_PASSWORD = 'HrdAdmin!2026';
const CHECKER_EMAIL = 'hr-checker@e2e.test';
const CHECKER_NAME = 'Chandra P.';
const CHECKER_PASSWORD = 'HrdAdmin!2026';
const EMPLOYEE_EMAIL = 'ada@company.com';
const EMPLOYEE_PASSWORD = 'EmployeeDemo!2026';

/** Addresses this run owns; cleanup keys on them alone. */
const APPROVE_EMAIL = 'dewi.approval@example.com';
const REJECT_EMAIL = 'reject.me.approval@example.com';
const WITHDRAW_EMAIL = 'withdraw.me.approval@example.com';
const NOTE_REJECT_EMAIL = 'note.check.approval@example.com';
const THIRD_HR_EMAIL = 'temp.hr.approval@example.com';
const FOURTH_HR_EMAIL = 'peer.hr.approval@example.com';
const FIFTH_HR_EMAIL = 'stale.target.approval@example.com';
const SIXTH_HR_EMAIL = 'reset.target.approval@example.com';

const OWNED_EMAILS = [
  APPROVE_EMAIL,
  REJECT_EMAIL,
  WITHDRAW_EMAIL,
  NOTE_REJECT_EMAIL,
  THIRD_HR_EMAIL,
  FOURTH_HR_EMAIL,
  FIFTH_HR_EMAIL,
  SIXTH_HR_EMAIL,
];

/** Chosen by the checker during the journey, then retired by cleanup. */
const NEW_PASSWORD = 'ApprovalFinal-2026!';
const THIRD_HR_PASSWORD = 'ThirdHrLogin-2026!';

// Same host-side default the identity jest setup (test/setup-env.ts) uses:
// `npm run e2e` carries no DATABASE_URL_MAIN, and the cleanup below is a
// host-side process like migrate.sh/seed.ts.
process.env.DATABASE_URL_MAIN ??= 'postgres://wfh:wfh@localhost:5432/wfh_main';

const prisma = new PrismaClient();

/** Escapes regex metacharacters so dictionary text is matched literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches one console string in whichever language the console shows. */
function eitherLanguage(key: DictKey): RegExp {
  const variants = [indonesianDictionary[key], englishDictionary[key]].map(
    escapeRegExp,
  );
  return new RegExp(variants.join('|'));
}

/** Removes every row this test could have left behind, in FK-safe order. */
async function purgeOwnedRows(): Promise<void> {
  const owned = await prisma.employee.findMany({
    where: { email: { in: OWNED_EMAILS } },
    select: { id: true },
  });
  const ids = owned.map((row) => row.id);
  await prisma.profileChangeEvent.deleteMany({
    where: {
      OR: [
        { employeeId: { in: ids } },
        { actorId: { in: ids } },
        { employee: { email: { in: OWNED_EMAILS } } },
      ],
    },
  });
  await prisma.hrAccessRequest.deleteMany({
    where: {
      OR: [
        { proposedEmail: { in: OWNED_EMAILS } },
        // Deactivation proposals carry no proposedEmail — they point at the
        // target account instead.
        { targetEmployeeId: { in: ids } },
      ],
    },
  });
  // Attendance rows hold a RESTRICT foreign key onto the employee row, so
  // the punches of this run's accounts have to go before the accounts do.
  await prisma.attendanceSession.deleteMany({
    where: { employeeId: { in: ids } },
  });
  await prisma.employee.deleteMany({
    where: { email: { in: OWNED_EMAILS } },
  });
}

test.beforeAll(async () => {
  // A crashed earlier run may have left rows behind; start from a clean slate.
  await purgeOwnedRows();
});

test.afterAll(async () => {
  await purgeOwnedRows();
  await prisma.$disconnect();
});

/** Signs in through the console's own form (the shell needs page identity). */
async function uiLogin(
  page: Page,
  email: string,
  password: string,
  destination = '**/karyawan',
) {
  await page.goto('/hrd/login');
  await page.fill('[name="email"]', email);
  await page.fill('[name="password"]', password);
  await page.click('[data-testid="login-submit"]');
  await page.waitForURL(destination, { timeout: 20000 });
}

/** Signs in over the API; the request context keeps the session cookie. */
async function apiLogin(
  request: APIRequestContext,
  email: string,
  password: string,
) {
  const response = await request.post('/api/identity/auth/login', {
    data: { email, password },
  });
  expect(response.status()).toBe(200);
}

/**
 * The proposal row that talks about one address. Extra filters are needed
 * when one address carries several proposals (an approved add plus a pending
 * deactivation of the same account), which strict mode would reject. Filters
 * chain one-by-one: this Playwright version never matches a hasText array.
 */
function rowFor(page: Page, email: string, extra?: (string | RegExp)[]) {
  let row = page.getByTestId('approval-row').filter({ hasText: email });
  for (const part of extra ?? []) {
    row = row.filter({ hasText: part });
  }
  return row;
}

/**
 * Proposes one HR account through the Akun HR directory: the add button on
 * the list opens the dedicated page, whose submit files the proposal. The
 * page stays open on a pending notice — the row only shows up in the inbox.
 */
async function proposeHr(page: Page, email: string, name: string) {
  await page.goto('/hrd/hr');
  await page.click('[data-testid="hr-add-button"]');
  await page.waitForURL('**/hr/add');
  await page.fill('#hr-add-name', name);
  await page.fill('#hr-add-email', email);
  await page.fill('#hr-add-position', 'HR Officer');
  await page.fill('#hr-add-phone', '+62-811-0000-0777');
  await page.click('[data-testid="hr-add-submit"]');
  await expect(page.getByTestId('hr-add-pending')).toBeVisible({
    timeout: 20000,
  });
}

/** Opens one account's edit page from the directory list. */
async function openHrEdit(page: Page, email: string) {
  await page.goto('/hrd/hr');
  const row = page
    .locator(
      '[data-testid="hr-account-row"]:visible, [data-testid="hr-account-card"]:visible',
    )
    .filter({ hasText: email });
  await row.getByTestId('hr-account-edit').click();
  await page.waitForURL('**/hr/*/edit', { timeout: 20000 });
  await expect(page.getByTestId('hr-edit')).toBeVisible();
}

/** Approves one pending row through the inbox's confirm modal. */
async function approveThroughModal(page: Page, row: ReturnType<typeof rowFor>) {
  await row.getByTestId('approval-approve').click();
  await expect(page.getByTestId('approval-confirm')).toBeVisible();
  // The panel lives below the table — it must scroll into view, or a long
  // list leaves the decision off-screen and the buttons look dead.
  await expect(page.getByTestId('approval-confirm')).toBeInViewport();
  await page.getByTestId('approval-confirm-yes').click();
}

/**
 * Rejects one pending row through the confirm modal. An empty reason is
 * refused inside the modal before any request leaves the browser.
 */
async function rejectThroughModal(
  page: Page,
  row: ReturnType<typeof rowFor>,
  reason: string,
) {
  await row.getByTestId('approval-reject').click();
  await expect(page.getByTestId('approval-confirm')).toBeVisible();
  await expect(page.getByTestId('approval-confirm')).toBeInViewport();
  await page.getByTestId('approval-confirm-yes').click();
  await expect(
    page.getByTestId('approval-confirm').getByRole('alert'),
  ).toContainText(eitherLanguage('form.error.required'));
  await page.getByTestId('approval-reason').fill(reason);
  await page.getByTestId('approval-confirm-yes').click();
}

/** Asserts an error answer carries exactly the uniform error triple. */
function expectUniformError(body: Record<string, unknown>, code: string) {
  expect(Object.keys(body).sort()).toEqual(['code', 'message', 'statusCode']);
  expect(body.code).toBe(code);
  expect(typeof body.message).toBe('string');
}

test.describe('003 maker-checker approval journey', () => {
  test('B1: propose, peer decides, one-time password, reject, withdraw', async ({
    browser,
    request,
  }) => {
    const makerContext = await browser.newContext();
    const checkerContext = await browser.newContext();
    const newObjectContext = await browser.newContext();
    const probeContext = await browser.newContext();
    const maker = await makerContext.newPage();
    const checker = await checkerContext.newPage();
    const newOwner = await newObjectContext.newPage();
    const probe = await probeContext.newPage();

    try {
      // --- 1. Maker signs in and proposes the first HR account through the
      //         Akun HR directory's add page. ---
      await uiLogin(maker, MAKER_EMAIL, MAKER_PASSWORD);
      await maker.goto('/hrd/hr');
      await expect(maker.getByTestId('hr-accounts')).toBeVisible();
      await proposeHr(maker, APPROVE_EMAIL, 'Dewi Approval');

      // --- 2. Peer sees the pending proposal. ---
      await uiLogin(checker, CHECKER_EMAIL, CHECKER_PASSWORD);
      await checker.goto('/hrd/approvals');
      const checkerRow = rowFor(checker, APPROVE_EMAIL);
      await expect(checkerRow).toBeVisible();
      await expect(checkerRow).toContainText(
        eitherLanguage('karyawan.approval.state.pending'),
      );

      // --- 3. Self-approval is refused: no button in the maker's own row,
      //         and the API answers 403 without touching anything. ---
      await maker.goto('/hrd/approvals');
      const makerRow = rowFor(maker, APPROVE_EMAIL);
      await expect(makerRow.getByTestId('approval-approve')).toHaveCount(0);
      await expect(makerRow).toContainText(
        eitherLanguage('karyawan.approval.selfHint'),
      );
      await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
      const ownRows = await request.get('/api/identity/hr-access-requests', {
        params: { state: 'pending', type: 'add_hr' },
      });
      expect(ownRows.status()).toBe(200);
      const ownBody = (await ownRows.json()) as {
        items: { id: string; proposedEmail: string }[];
      };
      const ownId = ownBody.items.find(
        (item) => item.proposedEmail === APPROVE_EMAIL,
      )?.id;
      expect(ownId).toBeTruthy();
      const selfApprove = await request.post(
        `/api/identity/hr-access-requests/${ownId}/approve`,
        { data: {} },
      );
      expect(selfApprove.status()).toBe(403);
      expectUniformError(await selfApprove.json(), 'FORBIDDEN');
      await expect(checkerRow).toContainText(
        eitherLanguage('karyawan.approval.state.pending'),
      );

      // --- 4. Peer approves through the confirm modal; the one-time
      //         password is revealed exactly once. ---
      await approveThroughModal(checker, checkerRow);
      const tempPanel = checker.getByTestId('approval-temp-password');
      await expect(tempPanel).toBeVisible({ timeout: 20000 });
      const temporaryPassword = (await tempPanel.locator('code').innerText())
        .trim();
      expect(temporaryPassword.length).toBeGreaterThan(0);
      await expect(tempPanel).toContainText(
        eitherLanguage('karyawan.approval.tempPasswordNote'),
      );
      await checker
        .getByRole('button', { name: eitherLanguage('password.done') })
        .click();
      await expect(tempPanel).toHaveCount(0);
      // A later refresh can never bring the password back.
      await checker.reload();
      await expect(checker.getByTestId('approval-temp-password')).toHaveCount(
        0,
      );
      await expect(checkerRow).toContainText(
        eitherLanguage('karyawan.approval.state.approved'),
      );
      // The decided-at cell renders the UTC instant as "YYYY-MM-DD HH:mm".
      await expect(checkerRow).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);

      // --- 5. The new account completes the forced first login, after which
      //         the one-time password no longer works. ---
      await uiLogin(newOwner, APPROVE_EMAIL, temporaryPassword, '**/first-login');
      await expect(newOwner.getByTestId('first-login')).toBeVisible();
      await newOwner.fill('[name="newPassword"]', NEW_PASSWORD);
      await newOwner.fill('[name="confirmPassword"]', NEW_PASSWORD);
      await newOwner.click('[data-testid="first-login-submit"]');
      await newOwner.waitForURL('**/karyawan', { timeout: 20000 });

      await probe.goto('/hrd/login');
      await probe.fill('[name="email"]', APPROVE_EMAIL);
      await probe.fill('[name="password"]', temporaryPassword);
      await probe.click('[data-testid="login-submit"]');
      await expect(probe.getByTestId('login-error')).toBeVisible({
        timeout: 20000,
      });
      await probe.fill('[name="password"]', NEW_PASSWORD);
      await probe.click('[data-testid="login-submit"]');
      await probe.waitForURL('**/karyawan', { timeout: 20000 });

      // --- 6. Reject: an empty reason is refused inside the confirm modal,
      //         a real one sticks and no account appears. ---
      await proposeHr(maker, REJECT_EMAIL, 'Reject Me');
      // The peer's console only reloads the list after its own actions, so a
      // proposal made elsewhere needs a refresh to appear.
      await checker.reload();
      const rejectRow = rowFor(checker, REJECT_EMAIL);
      await expect(rejectRow).toBeVisible({ timeout: 20000 });
      await rejectThroughModal(checker, rejectRow, 'Not a fit today');
      await expect(rejectRow).toContainText(
        eitherLanguage('karyawan.approval.state.rejected'),
        { timeout: 20000 },
      );
      await expect(rejectRow).toContainText('Not a fit today');
      expect(
        await prisma.employee.findUnique({ where: { email: REJECT_EMAIL } }),
      ).toBeNull();

      // --- 7. Withdraw: the maker cancels their own pending proposal. ---
      await proposeHr(maker, WITHDRAW_EMAIL, 'Withdraw Me');
      await maker.goto('/hrd/approvals');
      const withdrawRow = rowFor(maker, WITHDRAW_EMAIL);
      await expect(withdrawRow).toBeVisible({ timeout: 20000 });
      await withdrawRow.getByTestId('approval-withdraw').click();
      await expect(withdrawRow).toContainText(
        eitherLanguage('karyawan.approval.state.withdrawn'),
        { timeout: 20000 },
      );
      expect(
        await prisma.employee.findUnique({ where: { email: WITHDRAW_EMAIL } }),
      ).toBeNull();

      // --- 8. Decided rows are read-only for BOTH sessions: maker,
      //         checker, timestamp and note all present, no actions. ---
      for (const viewer of [maker, checker]) {
        const decided = rowFor(viewer, APPROVE_EMAIL);
        await expect(decided).toContainText(
          eitherLanguage('karyawan.approval.state.approved'),
        );
        // The checker column renders the deciding account's display name.
        await expect(decided).toContainText(CHECKER_NAME);
        await expect(decided.getByTestId('approval-approve')).toHaveCount(0);
        await expect(decided.getByTestId('approval-reject')).toHaveCount(0);
      }
      const rejectedForMaker = rowFor(maker, REJECT_EMAIL);
      await expect(rejectedForMaker).toContainText('Not a fit today');
      await expect(
        rejectedForMaker.getByTestId('approval-approve'),
      ).toHaveCount(0);

      // --- 9. Update: a name change travels the same four-eyes road —
      //         filed from the account's edit page, decided in the inbox. ---
      await openHrEdit(maker, APPROVE_EMAIL);
      await maker.fill('#hr-edit-name', 'Dewi Approval Renamed');
      await maker.click('[data-testid="hr-edit-save"]');
      await expect(maker.getByTestId('hr-edit-pending')).toBeVisible({
        timeout: 20000,
      });
      await checker.reload();
      const updateRow = rowFor(checker, APPROVE_EMAIL, [
        eitherLanguage('karyawan.approval.type.update_hr'),
      ]);
      await expect(updateRow).toBeVisible({ timeout: 20000 });
      await expect(updateRow).toContainText(
        eitherLanguage('karyawan.approval.state.pending'),
      );
      await approveThroughModal(checker, updateRow);
      await expect(updateRow).toContainText(
        eitherLanguage('karyawan.approval.state.approved'),
        { timeout: 20000 },
      );
      // Deactivation-style subjects aside, an update mints no password.
      await expect(checker.getByTestId('approval-temp-password')).toHaveCount(
        0,
      );
      const renamedId = (
        await prisma.employee.findUnique({
          where: { email: APPROVE_EMAIL },
          select: { id: true },
        })
      )!.id;
      const renamed = await request.get(`/api/identity/employees/${renamedId}`);
      expect(renamed.status()).toBe(200);
      expect(
        ((await renamed.json()) as { name: string }).name,
      ).toBe('Dewi Approval Renamed');
    } finally {
      await makerContext.close();
      await checkerContext.close();
      await newObjectContext.close();
      await probeContext.close();
    }
  });

  test('B3: API refusal answers carry exactly {statusCode, code, message}', async ({
    request,
  }) => {
    // No session at all → 401.
    const anonymous = await request.get('/api/identity/hr-access-requests');
    expect(anonymous.status()).toBe(401);
    expectUniformError(await anonymous.json(), 'AUTH_REQUIRED');

    // An employee session → 403 (default-deny, missing permission).
    await apiLogin(request, EMPLOYEE_EMAIL, EMPLOYEE_PASSWORD);
    const asEmployee = await request.get('/api/identity/hr-access-requests');
    expect(asEmployee.status()).toBe(403);
    expectUniformError(await asEmployee.json(), 'FORBIDDEN');

    // Reject without a reason → 400, then a peer id that does not exist → 404.
    await apiLogin(request, CHECKER_EMAIL, CHECKER_PASSWORD);
    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    const created = await request.post('/api/identity/hr-access-requests', {
      data: {
        type: 'add_hr',
        name: 'Note Check',
        email: NOTE_REJECT_EMAIL,
        position: 'HR Officer',
        phone: '+62-811-0000-0778',
      },
    });
    expect(created.status()).toBe(201);
    const proposal = (await created.json()) as { id: string };

    const missingNote = await request.post(
      `/api/identity/hr-access-requests/${proposal.id}/reject`,
      { data: { note: '   ' } },
    );
    expect(missingNote.status()).toBe(400);
    expectUniformError(await missingNote.json(), 'BAD_REQUEST');

    const unknownId = '00000000-0000-4000-8000-000000000000';
    const unknown = await request.post(
      `/api/identity/hr-access-requests/${unknownId}/approve`,
      { data: {} },
    );
    expect(unknown.status()).toBe(404);
    expectUniformError(await unknown.json(), 'NOT_FOUND');

    // Leave nothing pending behind for the cleanup pass.
    const withdrawn = await request.post(
      `/api/identity/hr-access-requests/${proposal.id}/withdraw`,
      { data: {} },
    );
    expect(withdrawn.status()).toBe(200);
  });

  test('B2: deactivation — access dies, history stays, one transition only', async ({
    browser,
    request,
  }) => {
    // --- A third HR joins through the same four-eyes flow, so the maker and
    //     checker pair survives while this account is deactivated below. ---
    // The shared request context holds ONE session cookie, so the maker
    // creates first and the checker's login replaces it before the decision.
    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    const thirdCreate = await request.post(
      '/api/identity/hr-access-requests',
      {
        data: {
          type: 'add_hr',
          name: 'Temp HR',
          email: THIRD_HR_EMAIL,
          position: 'HR Staff',
          phone: '+62-811-0000-0779',
        },
      },
    );
    expect(thirdCreate.status()).toBe(201);
    const thirdProposal = (await thirdCreate.json()) as { id: string };
    await apiLogin(request, CHECKER_EMAIL, CHECKER_PASSWORD);
    const thirdApprove = await request.post(
      `/api/identity/hr-access-requests/${thirdProposal.id}/approve`,
      { data: {} },
    );
    expect(thirdApprove.status()).toBe(200);
    const thirdTempPassword = (
      (await thirdApprove.json()) as { temporaryPassword: string }
    ).temporaryPassword;

    // The new HR finishes the forced first login in the console.
    const targetUiContext = await browser.newContext();
    const targetUi = await targetUiContext.newPage();
    try {
      await uiLogin(
        targetUi,
        THIRD_HR_EMAIL,
        thirdTempPassword,
        '**/first-login',
      );
      await targetUi.fill('[name="newPassword"]', THIRD_HR_PASSWORD);
      await targetUi.fill('[name="confirmPassword"]', THIRD_HR_PASSWORD);
      await targetUi.click('[data-testid="first-login-submit"]');
      await targetUi.waitForURL('**/karyawan', { timeout: 20000 });
    } finally {
      await targetUiContext.close();
    }

    // One durable profile-history row plus an open API session, both of which
    // outlive the account's access.
    const targetApiContext = await browser.newContext();
    const targetApi = targetApiContext.request;
    await apiLogin(targetApi, THIRD_HR_EMAIL, THIRD_HR_PASSWORD);
    const profileWrite = await targetApi.patch('/api/identity/profile', {
      data: { phone: '+62-811-0000-0790' },
    });
    expect(profileWrite.status()).toBe(200);
    // A punch gives the attendance side its own piece of history that the
    // deactivation must leave untouched — deactivation removes access, never
    // history rows.
    const punch = await targetApi.post('/api/attendance/punches', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { direction: 'masuk' },
    });
    expect(punch.status(), 'the punch must be recorded').toBe(200);
    const eventsBefore = await prisma.profileChangeEvent.count({
      where: { employee: { email: THIRD_HR_EMAIL } },
    });
    expect(eventsBefore).toBeGreaterThan(0);
    const thirdEmployee = await prisma.employee.findUnique({
      where: { email: THIRD_HR_EMAIL },
      select: { id: true },
    });
    expect(thirdEmployee).not.toBeNull();

    const makerContext = await browser.newContext();
    const checkerContext = await browser.newContext();
    const maker = await makerContext.newPage();
    const checker = await checkerContext.newPage();
    // E2E_DEBUG=1 traces every API answer the two consoles receive — the
    // diagnostic path for "the row never showed up" style failures.
    if (process.env.E2E_DEBUG !== undefined) {
      for (const [label, page] of [
        ['maker', maker],
        ['checker', checker],
      ] as const) {
        page.on('response', (response) => {
          if (response.url().includes('/api/')) {
            console.log(
              `[${label}] ${response.status()} ${response.request().method()} ${
                new URL(response.url()).pathname
              }`,
            );
          }
        });
      }
    }
    try {
      // --- B. The maker files the deactivation from the target's own edit
      //         page; the peer approves it in the inbox's confirm modal. ---
      await uiLogin(maker, MAKER_EMAIL, MAKER_PASSWORD);
      await openHrEdit(maker, THIRD_HR_EMAIL);
      const statusCard = maker.getByTestId('hr-edit-status-card');
      await statusCard
        .locator('input[name="hr-account-status"][value="deactivated"]')
        .check();
      await statusCard.getByTestId('hr-edit-status-apply').click();
      await expect(maker.getByTestId('hr-edit-confirm')).toBeVisible();
      await maker.getByTestId('hr-edit-confirm-yes').click();
      await expect(maker.getByTestId('hr-edit-pending')).toBeVisible({
        timeout: 20000,
      });
      // The address now carries two proposals (the approved add and this
      // deactivation); the kind label is stable across every state change,
      // so the row stays addressable before and after the decision.
      await maker.goto('/hrd/approvals');
      const makerRow = rowFor(maker, THIRD_HR_EMAIL, [
        eitherLanguage('karyawan.approval.type.deactivate_hr'),
      ]);
      await expect(makerRow).toBeVisible({ timeout: 20000 });

      await uiLogin(checker, CHECKER_EMAIL, CHECKER_PASSWORD);
      await checker.goto('/hrd/approvals');
      const checkerRow = rowFor(checker, THIRD_HR_EMAIL, [
        eitherLanguage('karyawan.approval.type.deactivate_hr'),
      ]);
      await expect(checkerRow).toBeVisible({ timeout: 20000 });
      await expect(checkerRow).toContainText(
        eitherLanguage('karyawan.approval.state.pending'),
      );
      // The decided-row subject is the target snapshot for this kind.
      await expect(checkerRow).toContainText('Temp HR');
      await approveThroughModal(checker, checkerRow);
      await expect(checkerRow).toContainText(
        eitherLanguage('karyawan.approval.state.approved'),
        { timeout: 20000 },
      );
      // Deactivation mints no one-time password.
      await expect(checker.getByTestId('approval-temp-password')).toHaveCount(
        0,
      );

      // --- C. The target's open session dies on the next request while the
      //         employee row and its history rows remain: deactivation
      //         removes access, never rows. ---
      const revoked = await targetApi.get('/api/identity/profile');
      expect(revoked.status()).toBe(401);
      expectUniformError(await revoked.json(), 'AUTH_REQUIRED');
      const afterEvents = await prisma.profileChangeEvent.count({
        where: { employee: { email: THIRD_HR_EMAIL } },
      });
      expect(afterEvents).toBeGreaterThanOrEqual(eventsBefore);
      const thirdAfter = await prisma.employee.findUnique({
        where: { email: THIRD_HR_EMAIL },
      });
      expect(thirdAfter).not.toBeNull();
      expect(thirdAfter?.status).toBe('deactivated');
      // The punch row survives its maker's deactivation: history stays.
      const attendanceLeft = await prisma.attendanceSession.findFirst({
        where: { employee: { email: THIRD_HR_EMAIL } },
        select: { id: true },
      });
      expect(attendanceLeft).not.toBeNull();
    } finally {
      await makerContext.close();
      await checkerContext.close();
      await targetApiContext.close();
    }

    // --- D. Concurrent double-approve: a fourth HR is added, then two
    //     simultaneous deactivation decisions must produce exactly one
    //     transition (one 200, one 409, target deactivated once). ---
    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    const fourthAdd = await request.post('/api/identity/hr-access-requests', {
      data: {
        type: 'add_hr',
        name: 'Peer HR',
        email: FOURTH_HR_EMAIL,
        position: 'HR Staff',
        phone: '+62-811-0000-0791',
      },
    });
    expect(fourthAdd.status()).toBe(201);
    const fourthAddId = ((await fourthAdd.json()) as { id: string }).id;
    await apiLogin(request, CHECKER_EMAIL, CHECKER_PASSWORD);
    const fourthApproved = await request.post(
      `/api/identity/hr-access-requests/${fourthAddId}/approve`,
      { data: {} },
    );
    expect(fourthApproved.status()).toBe(200);

    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    const fourthDeactivate = await request.post(
      '/api/identity/hr-access-requests',
      { data: { type: 'deactivate_hr', targetEmployeeId: (await prisma.employee.findUnique({ where: { email: FOURTH_HR_EMAIL }, select: { id: true } }))!.id } },
    );
    expect(fourthDeactivate.status()).toBe(201);
    const fourthDeactivateId = (
      (await fourthDeactivate.json()) as { id: string }
    ).id;

    const checkerAContext = await browser.newContext();
    const checkerBContext = await browser.newContext();
    try {
      await apiLogin(checkerAContext.request, CHECKER_EMAIL, CHECKER_PASSWORD);
      await apiLogin(checkerBContext.request, CHECKER_EMAIL, CHECKER_PASSWORD);
      const [decisionA, decisionB] = await Promise.all([
        checkerAContext.request.post(
          `/api/identity/hr-access-requests/${fourthDeactivateId}/approve`,
          { data: {} },
        ),
        checkerBContext.request.post(
          `/api/identity/hr-access-requests/${fourthDeactivateId}/approve`,
          { data: {} },
        ),
      ]);
      expect([decisionA.status(), decisionB.status()].sort()).toEqual([
        200, 409,
      ]);
      const fourthAfter = await prisma.employee.findUnique({
        where: { email: FOURTH_HR_EMAIL },
      });
      expect(fourthAfter?.status).toBe('deactivated');
      const transition = await prisma.hrAccessRequest.findUnique({
        where: { id: fourthDeactivateId },
      });
      expect(transition?.state).toBe('approved');
      expect(transition?.checkerEmployeeId).not.toBeNull();
      expect(transition?.decidedAt).not.toBeNull();
    } finally {
      await checkerAContext.close();
      await checkerBContext.close();
    }

    // --- E. Guard-refusal loop against the real API. The literal
    //         last-active-HR state cannot be forced live: a checker able to
    //         call approve is by definition still an active HR (RBAC re-reads
    //         role AND status per request and answers 403 to any out-of-band
    //         demotion), so the guard's `remaining < 1` branch is only
    //         reachable in-process — the identity-service unit suite pins it
    //         there. What this loop proves end-to-end is the same refusal
    //         contract through every layer the guard protects: a target taken
    //         out of band turns each approve into 409 CONFLICT, five times,
    //         with the proposal left pending and untouched each time. ---
    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    const fifthAdd = await request.post('/api/identity/hr-access-requests', {
      data: {
        type: 'add_hr',
        name: 'Stale Target',
        email: FIFTH_HR_EMAIL,
        position: 'HR Staff',
        phone: '+62-811-0000-0793',
      },
    });
    expect(fifthAdd.status()).toBe(201);
    const fifthAddId = ((await fifthAdd.json()) as { id: string }).id;
    await apiLogin(request, CHECKER_EMAIL, CHECKER_PASSWORD);
    const fifthApproved = await request.post(
      `/api/identity/hr-access-requests/${fifthAddId}/approve`,
      { data: {} },
    );
    expect(fifthApproved.status()).toBe(200);
    const fifthId = (
      await prisma.employee.findUnique({
        where: { email: FIFTH_HR_EMAIL },
        select: { id: true },
      })
    )!.id;

    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    const stalePropose = await request.post(
      '/api/identity/hr-access-requests',
      { data: { type: 'deactivate_hr', targetEmployeeId: fifthId } },
    );
    expect(stalePropose.status()).toBe(201);
    const staleId = ((await stalePropose.json()) as { id: string }).id;

    // Somebody takes the account away out of band before the checker looks.
    await prisma.employee.update({
      where: { email: FIFTH_HR_EMAIL },
      data: { status: 'deactivated' },
    });

    await apiLogin(request, CHECKER_EMAIL, CHECKER_PASSWORD);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await request.post(
        `/api/identity/hr-access-requests/${staleId}/approve`,
        { data: {} },
      );
      expect(refused.status(), `attempt ${attempt}`).toBe(409);
      expectUniformError(await refused.json(), 'CONFLICT');
    }
    const proposalAfterRefusals = await prisma.hrAccessRequest.findUnique({
      where: { id: staleId },
    });
    expect(proposalAfterRefusals?.state).toBe('pending');
    expect(proposalAfterRefusals?.decidedAt).toBeNull();
    expect(proposalAfterRefusals?.checkerEmployeeId).toBeNull();
    const fifthAfter = await prisma.employee.findUnique({
      where: { email: FIFTH_HR_EMAIL },
    });
    expect(fifthAfter?.status).toBe('deactivated');
    // The maker retires its own refused proposal so this run leaves the
    // shared checker and ivan fixtures exactly as it found them.
    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    const withdrawn = await request.post(
      `/api/identity/hr-access-requests/${staleId}/withdraw`,
      { data: {} },
    );
    expect(withdrawn.status()).toBe(200);
  });

  test('B4: reset_password — one credential dies, one is minted, access stays', async ({
    request,
    browser,
  }) => {
    // A sixth HR joins through the flow, so the reset has a live target.
    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    const sixthAdd = await request.post('/api/identity/hr-access-requests', {
      data: {
        type: 'add_hr',
        name: 'Reset Target',
        email: SIXTH_HR_EMAIL,
        position: 'HR Staff',
        phone: '+62-811-0000-0794',
      },
    });
    expect(sixthAdd.status()).toBe(201);
    const sixthAddId = ((await sixthAdd.json()) as { id: string }).id;
    await apiLogin(request, CHECKER_EMAIL, CHECKER_PASSWORD);
    const sixthApproved = await request.post(
      `/api/identity/hr-access-requests/${sixthAddId}/approve`,
      { data: {} },
    );
    expect(sixthApproved.status()).toBe(200);
    const firstPassword = (
      (await sixthApproved.json()) as { temporaryPassword: string }
    ).temporaryPassword;
    const sixthId = (
      await prisma.employee.findUnique({
        where: { email: SIXTH_HR_EMAIL },
        select: { id: true },
      })
    )!.id;

      // The target opens a session with the first credential.
      const targetContext = await browser.newContext();
      const targetApi = targetContext.request;
      try {
        await apiLogin(targetApi, SIXTH_HR_EMAIL, firstPassword);
        const openSession = await targetApi.get('/api/identity/profile');
        expect(openSession.status()).toBe(200);

        // The maker files the reset proposal from the target's edit page;
        // the peer decides it in the inbox's confirm modal, and the new
        // credential is revealed exactly once, in the row's panel.
        const makerContext = await browser.newContext();
        const checkerContext = await browser.newContext();
        const maker = await makerContext.newPage();
        const checker = await checkerContext.newPage();
        let secondPassword: string;
        try {
          await uiLogin(maker, MAKER_EMAIL, MAKER_PASSWORD);
          await openHrEdit(maker, SIXTH_HR_EMAIL);
          const passwordCard = maker.getByTestId('hr-edit-password-card');
          await passwordCard.getByTestId('hr-edit-reset').click();
          await expect(
            passwordCard.getByTestId('hr-edit-confirm'),
          ).toBeVisible();
          await passwordCard.getByTestId('hr-edit-confirm-yes').click();
          await expect(maker.getByTestId('hr-edit-pending')).toBeVisible({
            timeout: 20000,
          });

          await uiLogin(checker, CHECKER_EMAIL, CHECKER_PASSWORD);
          await checker.goto('/hrd/approvals');
          const resetRow = rowFor(checker, SIXTH_HR_EMAIL, [
            eitherLanguage('karyawan.approval.type.reset_password'),
          ]);
          await expect(resetRow).toBeVisible({ timeout: 20000 });
          await approveThroughModal(checker, resetRow);
          const tempPanel = checker.getByTestId('approval-temp-password');
          await expect(tempPanel).toBeVisible({ timeout: 20000 });
          secondPassword = (
            await tempPanel.locator('code').innerText()
          ).trim();
          expect(secondPassword.length).toBeGreaterThan(0);
          expect(secondPassword).not.toBe(firstPassword);
        } finally {
          await makerContext.close();
          await checkerContext.close();
        }

        // The open session dies; the old credential dies; the new one signs
        // in straight into the forced change; the account itself stays active.
        const revoked = await targetApi.get('/api/identity/profile');
        expect(revoked.status()).toBe(401);
        const staleLogin = await targetApi.post('/api/identity/auth/login', {
          data: { email: SIXTH_HR_EMAIL, password: firstPassword },
        });
        expect(staleLogin.status()).toBe(401);
        const freshLogin = await targetApi.post('/api/identity/auth/login', {
          data: { email: SIXTH_HR_EMAIL, password: secondPassword },
        });
        expect(freshLogin.status()).toBe(200);
        expect(
          ((await freshLogin.json()) as { mustChangePassword: boolean })
            .mustChangePassword,
        ).toBe(true);
        const targetRow = await prisma.employee.findUnique({
          where: { id: sixthId },
        });
        expect(targetRow?.status).toBe('active');
        const decidedRow = await prisma.hrAccessRequest.findFirst({
          where: {
            targetEmployeeId: sixthId,
            type: 'reset_password',
            state: 'approved',
          },
        });
        expect(decidedRow).not.toBeNull();
        expect(decidedRow?.checkerEmployeeId).not.toBeNull();
        expect(decidedRow?.decidedAt).not.toBeNull();
        // The target's own list flags the row as about themselves.
        const asTarget = await targetApi.get(
          '/api/identity/hr-access-requests',
        );
        const targetView = (
          (await asTarget.json()) as {
            items: { id: string; viewerIsTarget?: boolean }[];
          }
        ).items.find((row) => row.id === decidedRow!.id);
        expect(targetView?.viewerIsTarget).toBe(true);
      } finally {
        await targetContext.close();
      }
  });

  test('B5: side doors closed — no self-removal, no console edits of HR accounts', async ({
    request,
    browser,
  }) => {
    const checkerId = (
      await prisma.employee.findUnique({
        where: { email: CHECKER_EMAIL },
        select: { id: true },
      })
    )!.id;

    // A proposal to remove the checker cannot be approved by the checker.
    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    const proposed = await request.post(
      '/api/identity/hr-access-requests',
      { data: { type: 'deactivate_hr', targetEmployeeId: checkerId } },
    );
    expect(proposed.status()).toBe(201);
    const proposal = (await proposed.json()) as { id: string };

    await apiLogin(request, CHECKER_EMAIL, CHECKER_PASSWORD);
    const selfRemoval = await request.post(
      `/api/identity/hr-access-requests/${proposal.id}/approve`,
      { data: {} },
    );
    expect(selfRemoval.status()).toBe(403);
    expectUniformError(await selfRemoval.json(), 'FORBIDDEN');
    const untouched = await prisma.hrAccessRequest.findUnique({
      where: { id: proposal.id },
    });
    expect(untouched?.state).toBe('pending');
    expect(untouched?.checkerEmployeeId).toBeNull();
    expect(untouched?.decidedAt).toBeNull();

    // In the console the target sees the row flagged as their own removal,
    // with a hint and without any decision button.
    const checkerUiContext = await browser.newContext();
    const checkerUi = await checkerUiContext.newPage();
    try {
      await uiLogin(checkerUi, CHECKER_EMAIL, CHECKER_PASSWORD);
      await checkerUi.goto('/hrd/approvals');
      // Scoped to the pending state: a withdrawn proposal from an earlier
      // run may still sit in the shared table, and this run only speaks for
      // its own live row.
      const hintRow = rowFor(checkerUi, CHECKER_EMAIL, [
        eitherLanguage('karyawan.approval.type.deactivate_hr'),
        eitherLanguage('karyawan.approval.state.pending'),
      ]);
      await expect(hintRow).toBeVisible({ timeout: 20000 });
      await expect(hintRow.getByTestId('approval-target-hint')).toBeVisible();
      await expect(hintRow.getByTestId('approval-approve')).toHaveCount(0);
      await expect(hintRow.getByTestId('approval-reject')).toHaveCount(0);
    } finally {
      await checkerUiContext.close();
    }

    // A self-edit request meets the same wall: the checker cannot approve a
    // proposal that renames their own HR account, and the proposal waits.
    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    const selfEdit = await request.post('/api/identity/hr-access-requests', {
      data: {
        type: 'update_hr',
        targetEmployeeId: checkerId,
        name: 'Sneaky Rename',
      },
    });
    expect(selfEdit.status()).toBe(201);
    const selfEditId = ((await selfEdit.json()) as { id: string }).id;
    await apiLogin(request, CHECKER_EMAIL, CHECKER_PASSWORD);
    const selfEditApprove = await request.post(
      `/api/identity/hr-access-requests/${selfEditId}/approve`,
      { data: {} },
    );
    expect(selfEditApprove.status()).toBe(403);
    expectUniformError(await selfEditApprove.json(), 'FORBIDDEN');
    const selfEditUntouched = await prisma.hrAccessRequest.findUnique({
      where: { id: selfEditId },
    });
    expect(selfEditUntouched?.state).toBe('pending');
    expect(selfEditUntouched?.decidedAt).toBeNull();

    // The maker retires its own refused proposals.
    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    for (const retired of [proposal.id, selfEditId]) {
      const withdrawn = await request.post(
        `/api/identity/hr-access-requests/${retired}/withdraw`,
        { data: {} },
      );
      expect(withdrawn.status()).toBe(200);
    }

    // The console employee endpoints refuse an HR target outright: no edit,
    // no status flip, no one-eye password reset — the approval flow owns
    // every change to an HR account.
    await apiLogin(request, CHECKER_EMAIL, CHECKER_PASSWORD);
    const edit = await request.patch(
      `/api/identity/employees/${checkerId}`,
      { data: { name: 'Hijacked Name' } },
    );
    expect(edit.status()).toBe(403);
    expectUniformError(await edit.json(), 'FORBIDDEN');
    const statusFlip = await request.patch(
      `/api/identity/employees/${checkerId}/status`,
      { data: { status: 'deactivated' } },
    );
    expect(statusFlip.status()).toBe(403);
    const oneEyeReset = await request.post(
      `/api/identity/employees/${checkerId}/reset-password`,
    );
    expect(oneEyeReset.status()).toBe(403);
    const checkerRow = await prisma.employee.findUnique({
      where: { id: checkerId },
    });
    expect(checkerRow?.name).toBe(CHECKER_NAME);
    expect(checkerRow?.status).toBe('active');
  });

  test('B6: reactivation — the one-way door reopens through four eyes', async ({
    request,
    browser,
  }) => {
    const thirdId = (
      await prisma.employee.findUnique({
        where: { email: THIRD_HR_EMAIL },
        select: { id: true },
      })
    )!.id;

    // B2 leaves this account deactivated with its password untouched, so the
    // journey below must restore access to exactly that credential.
    const before = await prisma.employee.findUnique({
      where: { email: THIRD_HR_EMAIL },
    });
    expect(before?.status).toBe('deactivated');
    const hashBefore = before!.passwordHash;

    // --- A. A stale race: the proposal is filed, then the account is
    //     restored out-of-band before the decision, so the approval refuses
    //     and the proposal waits rather than flipping an already-active
    //     account. ---
    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    const stalePropose = await request.post(
      '/api/identity/hr-access-requests',
      { data: { type: 'reactivate_hr', targetEmployeeId: thirdId } },
    );
    expect(stalePropose.status()).toBe(201);
    const staleId = ((await stalePropose.json()) as { id: string }).id;
    await prisma.employee.update({
      where: { id: thirdId },
      data: { status: 'active' },
    });
    await apiLogin(request, CHECKER_EMAIL, CHECKER_PASSWORD);
    const staleApprove = await request.post(
      `/api/identity/hr-access-requests/${staleId}/approve`,
      { data: {} },
    );
    expect(staleApprove.status()).toBe(409);
    expectUniformError(await staleApprove.json(), 'CONFLICT');
    const staleRow = await prisma.hrAccessRequest.findUnique({
      where: { id: staleId },
    });
    expect(staleRow?.state).toBe('pending');
    expect(staleRow?.decidedAt).toBeNull();
    expect(staleRow?.checkerEmployeeId).toBeNull();
    // The deactivated state returns for the journey below, and the maker
    // retires the refused proposal.
    await prisma.employee.update({
      where: { id: thirdId },
      data: { status: 'deactivated' },
    });
    await apiLogin(request, MAKER_EMAIL, MAKER_PASSWORD);
    const staleWithdraw = await request.post(
      `/api/identity/hr-access-requests/${staleId}/withdraw`,
      { data: {} },
    );
    expect(staleWithdraw.status()).toBe(200);

    // --- B. The edit page of a deactivated account offers the reactivation
    //     instead of the status radios, and files it behind its own confirm
    //     modal. ---
    const makerContext = await browser.newContext();
    const checkerContext = await browser.newContext();
    const maker = await makerContext.newPage();
    const checker = await checkerContext.newPage();
    try {
      await uiLogin(maker, MAKER_EMAIL, MAKER_PASSWORD);
      await openHrEdit(maker, THIRD_HR_EMAIL);
      const statusCard = maker.getByTestId('hr-edit-status-card');
      await expect(statusCard.getByTestId('hr-edit-reactivate')).toBeVisible();
      await expect(statusCard.getByTestId('hr-edit-status-apply')).toHaveCount(
        0,
      );
      await statusCard.getByTestId('hr-edit-reactivate').click();
      await expect(maker.getByTestId('hr-edit-confirm')).toBeVisible();
      // The confirm must be reachable without scrolling-blindness: it lives
      // inside the card, so it has to be on-screen where the click landed.
      await expect(maker.getByTestId('hr-edit-confirm')).toBeInViewport();
      await maker.getByTestId('hr-edit-confirm-yes').click();
      await expect(maker.getByTestId('hr-edit-pending')).toBeVisible({
        timeout: 20000,
      });

      // --- C. The peer approves in the inbox: the account returns, with no
      //     one-time password minted for this kind. This address now carries
      //     two reactivate rows (the withdrawn stale one and this pending
      //     one), so the state is part of each locator — before the decision
      //     and after it. ---
      await uiLogin(checker, CHECKER_EMAIL, CHECKER_PASSWORD);
      await checker.goto('/hrd/approvals');
      const pendingRow = rowFor(checker, THIRD_HR_EMAIL, [
        eitherLanguage('karyawan.approval.type.reactivate_hr'),
        eitherLanguage('karyawan.approval.state.pending'),
      ]);
      await expect(pendingRow).toBeVisible({ timeout: 20000 });
      await approveThroughModal(checker, pendingRow);
      const approvedRow = rowFor(checker, THIRD_HR_EMAIL, [
        eitherLanguage('karyawan.approval.type.reactivate_hr'),
        eitherLanguage('karyawan.approval.state.approved'),
      ]);
      await expect(approvedRow).toBeVisible({ timeout: 20000 });
      await expect(checker.getByTestId('approval-temp-password')).toHaveCount(
        0,
      );
    } finally {
      await makerContext.close();
      await checkerContext.close();
    }

    // --- D. Access is back on the same credential: the target logs in with
    //     its pre-deactivation password and no new password material exists
    //     on the row. ---
    const reactivated = await prisma.employee.findUnique({
      where: { email: THIRD_HR_EMAIL },
    });
    expect(reactivated?.status).toBe('active');
    expect(reactivated?.passwordHash).toBe(hashBefore);
    const targetContext = await browser.newContext();
    try {
      await apiLogin(targetContext.request, THIRD_HR_EMAIL, THIRD_HR_PASSWORD);
      const profile = await targetContext.request.get('/api/identity/profile');
      expect(profile.status()).toBe(200);
      const body = (await profile.json()) as { email: string };
      expect(body.email).toBe(THIRD_HR_EMAIL);
    } finally {
      await targetContext.close();
    }
  });
});
