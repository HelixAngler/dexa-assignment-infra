# design-qa — visual-QA harness

Playwright harness that captures, contrast-checks and layout-checks the two
single-page apps behind the local stack: the employee app at
`http://localhost:8080/` and the HRD console at `http://localhost:8080/hrd/`.
It is a **separate configuration** from the regression suite in `e2e/` — that
suite stays untouched and is not run from here.

## Layout

```
design-qa/
├── playwright.config.ts   # 4 projects: phone|desktop × id|en (360×740 / 960×900)
├── fixtures.ts            # extended `test`: seeds localStorage['lang'] via addInitScript
├── screens.ts             # 23 screen ids → routes + reach recipe (import, don't hardcode)
├── tsconfig.json          # typecheck for this folder: `npx tsc -p design-qa/tsconfig.json`
└── specs/                 # testDir — smoke lives here, audit specs land next
```

## Running

```bash
npm run lint && npm run typecheck          # package-wide checks
npx tsc -p design-qa/tsconfig.json         # this folder's typecheck
npx playwright test --config design-qa/playwright.config.ts            # everything
npx playwright test --config design-qa/playwright.config.ts --project=phone-en
npm run design:contrast                    # specs whose file name matches "contrast"
npm run design:layout                      # specs whose file name matches "layout"
```

## Rules for spec authors

1. **Import `test` and `expect` from `../fixtures`, never from
   `'@playwright/test'`.** Only the harness test seeds the project language;
   the stock test would fall back to the default language in the `*-en`
   projects.
2. **Import routes from `../screens`.** Every screen id has an entry with its
   route, its `reach` (`static` | `session` | `fixture`) and a `reachHint`
   recipe. Parameterised routes go through `routeFor('hrd.karyawan.edit',
{ id })` so a missing id fails loudly.
3. **Sessions reuse cookies, nothing on disk.** Sign in once per test with
   `context.request.post('/api/identity/auth/login', { data: { email,
password } })`, navigate normally afterwards, and log out with
   `context.request.post('/api/identity/auth/logout')` at the end. Each test
   gets a fresh context, so no session outlives it. Credentials come from the
   stack's seed script (`scripts/seed.ts`).
4. **Spec file names are the commands' wiring.** `design:contrast` runs files
   whose name matches `contrast`, `design:layout` matches `layout` — e.g.
   `employee-contrast.spec.ts`, `hrd-contrast.spec.ts`,
   `employee-layout.spec.ts`, `hrd-layout.spec.ts`.
5. Multi-context journeys that build their own context must call
   `context.addInitScript` with the same seeding as `fixtures.ts` themselves.
