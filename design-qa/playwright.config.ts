import { defineConfig } from '@playwright/test';

import type { DesignQaArgs } from './fixtures';

/**
 * Visual-QA harness for the two single-page apps the local stack serves behind
 * one edge: the employee app at the root address (http://localhost:8080/) and
 * the HRD console mounted under /hrd/ (http://localhost:8080/hrd/).
 *
 * This configuration is deliberately separate from the regression suite's
 * configuration in e2e/: that one is serial because its tests write state,
 * while this harness only reads the running stack, so it may run a small
 * worker pool. The two suites keep their artifacts apart by using their own
 * test directories.
 *
 * Four projects cover the two required screen shapes — a ~360 px phone and a
 * ~960 px desktop — each in both interface languages:
 *
 *   phone-id     360x740, Indonesian   phone-en     360x740, English
 *   desktop-id   960x900, Indonesian   desktop-en   960x900, English
 *
 * Language seeding: both apps read their language from `localStorage` under
 * the key 'lang' during the first render (the same key their in-app toggle
 * writes). Each project therefore installs its locale through the context
 * fixture in ./fixtures.ts, which calls `context.addInitScript` before any
 * page exists. Init scripts run before the application's own scripts on every
 * navigation, so the seeded value is in place before the first render: no
 * toggle click, no flash of the default language, and the choice survives
 * reloads and client-side routing exactly like a user's own pick would.
 *
 * Session strategy for the screens that need a signed-in state: the cookie
 * reuse the regression suite in e2e/ uses — a test signs in once through the
 * identity API (`POST /api/identity/auth/login` via the context's request
 * object), the Set-Cookie session lands in that browser context, every later
 * navigation reuses it, and the test ends with `POST /api/identity/auth/logout`.
 * Each test gets a fresh context, so sessions never outlive their test and
 * nothing is written to disk. Which screens need a session (and which need
 * extra set-up such as a provisioned account, a row id or a mocked response)
 * is recorded per screen in ./screens.ts.
 *
 * Transient run artifacts (failed-test traces, screenshots, videos) land in
 * ./test-results, which is ignored version-control-wide for this package;
 * delete it between runs if you want a clean slate.
 */

/**
 * The edge publishes the stack on a host port that is overridable, so a
 * machine where 8080 already belongs to another local service can point
 * DESIGN_QA_BASE_URL (or the regression suite's E2E_BASE_URL, shared on
 * purpose) at the edge instead.
 */
const baseURL =
  process.env.DESIGN_QA_BASE_URL ?? process.env.E2E_BASE_URL ?? 'http://localhost:8080';

export default defineConfig<DesignQaArgs>({
  // Every spec of this harness lives under design-qa/specs.
  testDir: './specs',
  // Per-run artifacts stay beside the suite, out of version control.
  outputDir: './test-results',
  reporter: 'list',
  // Conservative on purpose: all workers share one running stack.
  workers: 2,
  // No retries — a visual or accessibility failure is a finding to fix,
  // not flake to average away.
  retries: 0,
  use: {
    baseURL,
  },
  projects: [
    {
      name: 'phone-id',
      use: { viewport: { width: 360, height: 740 }, designLang: 'id' },
    },
    {
      name: 'phone-en',
      use: { viewport: { width: 360, height: 740 }, designLang: 'en' },
    },
    {
      name: 'desktop-id',
      use: { viewport: { width: 960, height: 900 }, designLang: 'id' },
    },
    {
      name: 'desktop-en',
      use: { viewport: { width: 960, height: 900 }, designLang: 'en' },
    },
  ],
});
