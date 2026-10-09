/**
 * Screen map for the visual-QA harness: one entry per screen id of the
 * visual inventory (23 ids — 13 employee, 10 console). Spec files import this
 * module instead of hardcoding paths, so a route rename lands in exactly one
 * place and every capture knows how much set-up its screen needs.
 *
 * Routes are the paths the running edge actually serves:
 *   - employee screens sit at the root address (/login, /absen, ...);
 *   - console screens all carry the /hrd mount prefix — the console's own
 *     router paths (/karyawan, /absensi, ...) are relative to it;
 *   - profile sub-screens use the apps' Indonesian slugs (telepon, foto,
 *     kata-sandi), which are what the employee router registers — the
 *     English-style labels used when naming the screens are labels only.
 *
 * Session strategy for every screen whose `reach` mentions a session: reuse
 * the cookie flow of the regression suites in e2e/ — sign in once per test
 * with the context's request object
 * (`await context.request.post('/api/identity/auth/login', { data: { email,
 * password } })`), let the Set-Cookie session land in the browser context,
 * then navigate normally; end the test with
 * `context.request.post('/api/identity/auth/logout')`. Playwright hands each
 * test a fresh context, so no session outlives its test and nothing is
 * persisted to disk. Account credentials come from the stack's seed script
 * (scripts/seed.ts); accounts with a forced pending password change are
 * provisioned the same way the e2e suites provision theirs when a screen
 * needs one.
 */

/** Which app behind the edge serves the screen. */
export type ScreenApp = 'employee' | 'hrd';

/**
 * How much set-up a capture needs before the screen can be opened:
 *
 * - 'static'  — loading the route while signed out already shows the screen.
 * - 'session' — needs a signed-in session of the right role first (see the
 *               session strategy in the header).
 * - 'fixture' — needs more than a signed-in page load: test-owned data (an
 *               account in a particular state, a row id, a filtered-empty
 *               view), a mocked or failing network response, or an in-screen
 *               interaction such as opening a confirmation.
 */
export type Reach = 'static' | 'session' | 'fixture';

/** One screen's entry: where it lives and how to get it into shape. */
export interface ScreenTarget {
  app: ScreenApp;
  /** Absolute path on the edge; `:param` segments need `routeFor`. */
  route: string;
  reach: Reach;
  /** The concrete recipe behind `reach`. */
  reachHint: string;
}

/** All 23 screen ids, in inventory order. */
export const screenIds = [
  'emp.login',
  'emp.login.locked',
  'emp.first-login',
  'emp.profil',
  'emp.profil.phone',
  'emp.profil.photo',
  'emp.profil.password',
  'emp.absen.baru',
  'emp.absen.kerja',
  'emp.absen.conflict',
  'emp.absen.offline',
  'emp.summary.default',
  'emp.summary.empty',
  'hrd.login',
  'hrd.karyawan.list',
  'hrd.karyawan.add',
  'hrd.karyawan.edit',
  'hrd.karyawan.deactivate',
  'hrd.absensi',
  'hrd.absensi.empty',
  'hrd.banner.single',
  'hrd.banner.stack',
  'hrd.denied',
] as const;

/** One id of the visual inventory. */
export type ScreenId = (typeof screenIds)[number];

/**
 * Id → route/recipe map. The explicit annotation keeps the table honest: a
 * missing id and an unknown id are both compile errors.
 */
export const screens: Readonly<Record<ScreenId, ScreenTarget>> = {
  'emp.login': {
    app: 'employee',
    route: '/login',
    reach: 'static',
    reachHint:
      'Open the route signed out — the session guard shows the sign-in screen to anonymous visitors, and "/" redirects here for them.',
  },
  'emp.login.locked': {
    app: 'employee',
    route: '/login',
    reach: 'fixture',
    reachHint:
      'Sign-in must be locked first: drive repeated failed attempts against one account (or pre-lock its row) until the attention/lock copy with the retry-after line replaces the plain form; the route stays /login.',
  },
  'emp.first-login': {
    app: 'employee',
    route: '/first-login',
    reach: 'session',
    reachHint:
      'Sign in with an account whose password change is pending (the seed script ships one): the guard owns every address until the change is saved, so any navigation lands on this screen.',
  },
  'emp.profil': {
    app: 'employee',
    route: '/profil',
    reach: 'session',
    reachHint: 'Employee session; open the route and read the profile rows as seeded.',
  },
  'emp.profil.phone': {
    app: 'employee',
    route: '/profil/telepon',
    reach: 'session',
    reachHint:
      'Employee session; open the route. The invalid-inline variant is driven by typing <8 digits.',
  },
  'emp.profil.photo': {
    app: 'employee',
    route: '/profil/foto',
    reach: 'session',
    reachHint:
      'Employee session; open the route. The size/type error variant needs a rejected file picked through the upload control.',
  },
  'emp.profil.password': {
    app: 'employee',
    route: '/profil/kata-sandi',
    reach: 'session',
    reachHint:
      'Employee session; open the route. Mismatch/weak variants are driven by the form fields themselves.',
  },
  'emp.absen.baru': {
    app: 'employee',
    route: '/absen',
    reach: 'fixture',
    reachHint:
      'Employee session whose account has not punched in yet today (a fresh account, or a run before any punch): the punch button must read ABSEN MASUK and the last-punch line must show no punch for today.',
  },
  'emp.absen.kerja': {
    app: 'employee',
    route: '/absen',
    reach: 'fixture',
    reachHint:
      'Same as emp.absen.baru after a clock-in: punch once (or seed an open attendance session for today) so the hero shows the since-time and the button reads ABSEN PULANG.',
  },
  'emp.absen.conflict': {
    app: 'employee',
    route: '/absen',
    reach: 'fixture',
    reachHint:
      'Employee session plus a conflicting punch answer: intercept the punch request and reply with the conflict error (or race a second punch) so the conflict overlay opens over the reserved layout; its action reads "Muat ulang".',
  },
  'emp.absen.offline': {
    app: 'employee',
    route: '/absen',
    reach: 'fixture',
    reachHint:
      'Employee session plus network failure: abort the attendance requests through route interception so the offline overlay with its reassurance copy shows while the layout stays reserved; its action reads "Coba lagi".',
  },
  'emp.summary.default': {
    app: 'employee',
    route: '/summary',
    reach: 'session',
    reachHint:
      'Employee session; open the route and leave the filter at its default (month up to today) so the table/cards render.',
  },
  'emp.summary.empty': {
    app: 'employee',
    route: '/summary',
    reach: 'fixture',
    reachHint:
      'Employee session plus a filter range with no rows (a future window works): set the range through the form so the empty block with "Ubah rentang" renders.',
  },
  'hrd.login': {
    app: 'hrd',
    route: '/hrd/login',
    reach: 'static',
    reachHint:
      'Open the route signed out — the console guard shows its sign-in screen, and "/hrd/" redirects here for anonymous visitors.',
  },
  'hrd.karyawan.list': {
    app: 'hrd',
    route: '/hrd/karyawan',
    reach: 'session',
    reachHint:
      'Console session (an HRD-role account); the mount root redirects to this list. Table-versus-cards follows the viewport, so both projects capture it as-is.',
  },
  'hrd.karyawan.add': {
    app: 'hrd',
    route: '/hrd/karyawan/add',
    reach: 'session',
    reachHint:
      'Console session; open the route. The duplicate-email and temp-password variants are driven through the form itself.',
  },
  'hrd.karyawan.edit': {
    app: 'hrd',
    route: '/hrd/karyawan/:id/edit',
    reach: 'fixture',
    reachHint:
      'Console session plus a real employee id: read one off the list (or provision a row) and substitute it with routeFor(id, { id: ... }).',
  },
  'hrd.karyawan.deactivate': {
    app: 'hrd',
    route: '/hrd/karyawan/:id/edit',
    reach: 'fixture',
    reachHint:
      'Same id as hrd.karyawan.edit, then open the deactivate confirmation (the danger action) so its attention copy is on screen — open only, never confirm it.',
  },
  'hrd.absensi': {
    app: 'hrd',
    route: '/hrd/absensi',
    reach: 'session',
    reachHint:
      'Console session; open the route with the date at its default (today) and an empty search so every employee row renders.',
  },
  'hrd.absensi.empty': {
    app: 'hrd',
    route: '/hrd/absensi',
    reach: 'fixture',
    reachHint:
      'Console session plus a date/query that matches nobody: drive the controls so the empty block with "Ubah tanggal/cari" renders.',
  },
  'hrd.banner.single': {
    app: 'hrd',
    route: '/hrd/karyawan',
    reach: 'fixture',
    reachHint:
      'Console session inside the shell (any mounted console route works; the list is representative) plus exactly one incoming banner: mock or wait for a single notification so the raised non-modal banner with its dismiss control shows.',
  },
  'hrd.banner.stack': {
    app: 'hrd',
    route: '/hrd/karyawan',
    reach: 'fixture',
    reachHint:
      'Console session inside the shell plus three or more incoming banners: the shell stacks them with a "+N more" collapse and the raised shadow; representative route as for hrd.banner.single.',
  },
  'hrd.denied': {
    app: 'hrd',
    route: '/hrd/karyawan',
    reach: 'session',
    reachHint:
      'Sign in as a non-HRD account (an employee session) and open any console route: the guard renders the denied state instead of the shell. The listed route is representative — the denied state replaces every address under the mount.',
  },
};

/** One inventory screen, tagged with its id. */
export interface ScreenEntry extends ScreenTarget {
  id: ScreenId;
}

/** Metadata of one screen; throws when the id is not in the inventory. */
export function screen(id: ScreenId): ScreenTarget {
  return screens[id];
}

/** Every entry, id included — convenient for coverage loops. */
export function allScreens(): ScreenEntry[] {
  return screenIds.map((id) => ({ id, ...screens[id] }));
}

/** The entries of one app ('employee' → 13, 'hrd' → 10). */
export function screensOf(app: ScreenApp): ScreenEntry[] {
  return allScreens().filter((entry) => entry.app === app);
}

/**
 * The screen's route with every `:param` segment substituted, e.g.
 * `routeFor('hrd.karyawan.edit', { id })`. Throws when a parameter is left
 * out, so a capture fails loudly instead of navigating to a broken URL.
 */
export function routeFor(id: ScreenId, params: Readonly<Record<string, string>> = {}): string {
  const { route } = screens[id];
  return route.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_segment, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') {
      throw new Error(`screen "${id}": route "${route}" needs parameter "${name}"`);
    }
    return value;
  });
}
