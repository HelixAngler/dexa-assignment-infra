import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './',
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:80',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'phone',
      use: {
        viewport: { width: 360, height: 740 },
      },
    },
  ],
});
