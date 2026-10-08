import { expect, test } from '@playwright/test';

/**
 * Browser smoke for the employee console: sign in through the real edge,
 * land on the Absen screen and reach the punch button. Read-only on purpose —
 * it never presses the punch button, so it can run in every viewport project
 * without writing attendance rows.
 */

const EMAIL = 'ada@company.com';
const PASSWORD = 'EmployeeDemo!2026';

test('employee signs in and reaches the punch button', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('login')).toBeVisible();

  await page.locator('#login-email').fill(EMAIL);
  await page.locator('#login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();

  await expect(page).toHaveURL(/\/absen$/);
  await expect(page.getByTestId('absen')).toBeVisible();
  await expect(page.getByTestId('absen-status')).toBeVisible();

  const punchButton = page.getByTestId('punch-button');
  await expect(punchButton).toBeVisible();
  await expect(punchButton).toBeEnabled();
  // Depending on the current state the button offers clock-in or clock-out.
  await expect(punchButton).toHaveText(/^ABSEN (MASUK|PULANG)$/);
});
