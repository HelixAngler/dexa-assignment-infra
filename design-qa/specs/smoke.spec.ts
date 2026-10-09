import type { Page } from '@playwright/test';

import { en as employeeEnglish } from '../../../employee-web/src/i18n/en';
import { id as employeeIndonesian } from '../../../employee-web/src/i18n/id';
import { en as consoleEnglish } from '../../../hrd-web/src/i18n/en';
import { id as consoleIndonesian } from '../../../hrd-web/src/i18n/id';
import { LANGUAGE_STORAGE_KEY, expect, test } from '../fixtures';

/**
 * Harness smoke: proves the pieces every later spec leans on work against the
 * running stack — the edge answers for both apps, each sign-in screen renders,
 * and the project's locale was installed into storage before the first render.
 * The last part is checked through the sign-in heading, which must come from
 * the seeded locale's dictionary rather than the product default, so a
 * project whose language seeding silently stopped working fails here.
 */

/** The locale a project installs, read off its name (…-id / …-en). */
function projectLocale(projectName: string): 'id' | 'en' {
  return projectName.endsWith('-en') ? 'en' : 'id';
}

/** The language the page kept in its own storage, or null when it kept none. */
function storedLanguage(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), LANGUAGE_STORAGE_KEY);
}

test('employee app root answers 200 and renders the project locale', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo.project.name);

  const response = await page.goto('/');
  expect(response?.status(), 'the edge must answer the root address with 200').toBe(200);
  await expect(page.getByTestId('login')).toBeVisible();

  expect(
    await storedLanguage(page),
    'the project must have seeded its language before the first render',
  ).toBe(locale);

  const heading =
    locale === 'en' ? employeeEnglish['login.title'] : employeeIndonesian['login.title'];
  await expect(
    page.locator('h1'),
    'the sign-in heading must come from the seeded locale',
  ).toHaveText(heading);
});

test('console root answers 200 and renders the project locale', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo.project.name);

  const response = await page.goto('/hrd/');
  expect(response?.status(), 'the edge must answer the console mount with 200').toBe(200);
  await expect(page).toHaveURL(/\/hrd\/login$/);
  await expect(page.getByTestId('login')).toBeVisible();

  expect(
    await storedLanguage(page),
    'the project must have seeded its language before the first render',
  ).toBe(locale);

  const heading =
    locale === 'en' ? consoleEnglish['login.title'] : consoleIndonesian['login.title'];
  await expect(
    page.locator('h1'),
    'the sign-in heading must come from the seeded locale',
  ).toHaveText(heading);
});
