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
      name: 'desktop',
      // Viewport projects are for browser specs; the request-only contract
      // suite has its own single project so it executes exactly once.
      testIgnore: /contract-.*\.spec\.ts/,
      use: {
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'phone',
      testIgnore: /contract-.*\.spec\.ts/,
      use: {
        viewport: { width: 360, height: 740 },
      },
    },
    {
      name: 'contract',
      testMatch: /contract-.*\.spec\.ts/,
    },
  ],
});
