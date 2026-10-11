import { defineConfig } from '@playwright/test';

/**
 * The edge (Caddy) publishes the stack on a host port that is overridable:
 * machines where 80/443 already belong to another local service move the edge
 * elsewhere and point E2E_BASE_URL at it.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './',
  reporter: 'list',
  // Stateful suites (login counters, punch rows) must never run twice at once,
  // so the whole run is serial.
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL,
  },
  projects: [
    {
      name: 'contract',
      // Request-only contract suites carry their own single project so they
      // execute exactly once.
      testMatch: /contract-.*\.spec\.ts/,
    },
    {
      // A stateful two-context journey owns its own project: it must run
      // exactly once per invocation, while the viewport projects below would
      // otherwise replay it once per viewport.
      name: 'us2-banner',
      testMatch: /us2-banner\.spec\.ts/,
      use: {
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      // Stateful maker-checker journey: exactly once per run.
      name: 'hr-access',
      testMatch: /hr-access\.approval\.spec\.ts/,
      use: {
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'desktop',
      // Viewport projects are for browser specs that tolerate every viewport;
      // the request-only contract suite and the stateful journeys are excluded.
      testIgnore: [
        /contract-.*\.spec\.ts/,
        /us2-banner\.spec\.ts/,
        /hr-access\.approval\.spec\.ts/,
      ],
      use: {
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'phone',
      testIgnore: [
        /contract-.*\.spec\.ts/,
        /us2-banner\.spec\.ts/,
        /hr-access\.approval\.spec\.ts/,
      ],
      use: {
        viewport: { width: 360, height: 740 },
      },
    },
  ],
});
