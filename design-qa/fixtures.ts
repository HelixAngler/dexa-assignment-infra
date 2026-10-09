import { test as base, expect } from '@playwright/test';

/**
 * Fixtures shared by every spec under design-qa/specs.
 *
 * Import `test` and `expect` from THIS module, not from '@playwright/test':
 * the extended test below is what installs each project's language into the
 * browser before the application's own scripts run. A spec that imports the
 * stock test would silently fall back to the product's default language in
 * the `*-en` projects and produce misleading captures.
 *
 * Specs that build their own browser context on top of the `browser` fixture
 * (multi-context journeys) bypass this hook; they must call
 * `context.addInitScript` with `seedLanguage` themselves.
 */

/** Project-scoped options; the values live in ./playwright.config.ts. */
export interface DesignQaArgs {
  /**
   * Language to install into `localStorage` before any application script
   * runs: 'id' (the product default) or 'en'.
   */
  designLang: 'id' | 'en';
}

/** `localStorage` key both apps keep the chosen language under. */
const LANGUAGE_STORAGE_KEY = 'lang';

/**
 * The script every context of this harness runs before the page's own code:
 * it writes the project's language under the exact key the apps' language
 * provider reads on first render, so the seeded value is indistinguishable
 * from a user's own pick (reload-safe, toggle-safe).
 */
function seedLanguageScript(lang: DesignQaArgs['designLang']): void {
  try {
    window.localStorage.setItem('lang', lang);
  } catch {
    // Storage may be unavailable (private mode, disabled cookies); the app
    // falls back to its own default language on its own.
  }
}

export const test = base.extend<DesignQaArgs>({
  designLang: ['id', { option: true }],

  // Override the built-in context fixture while still using it: the base
  // implementation creates the context with the project's viewport, baseURL
  // and friends, and the init script is added before any page exists.
  context: async ({ context, designLang }, use) => {
    await context.addInitScript(seedLanguageScript, designLang);
    await use(context);
  },
});

export { expect, LANGUAGE_STORAGE_KEY };
