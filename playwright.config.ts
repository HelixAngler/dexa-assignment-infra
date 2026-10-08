// Playwright only ever looks for a configuration file in the directory the
// command is run from, while the suite itself lives in e2e/. This alias points
// the runner at the real configuration so that
// `npx playwright test e2e/<file>` behaves exactly like the `e2e` script.
export { default } from './e2e/playwright.config';
