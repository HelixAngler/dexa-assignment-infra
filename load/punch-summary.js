/* global __ENV, __ITER, __VU */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

/**
 * Punch + summary load at ten times the worst-case company size.
 *
 * Scenario reading: the worst case is a company of 500 employee accounts and
 * the required load is 10x the expected peak against that sizing, so the
 * driver runs 5,000 virtual users — one per fixture account — and leaves each
 * user at a normal interactive pace: one punch plus one summary read per
 * minute, with 20% jitter. Ten times the 500-employee baseline at the same
 * per-employee pace is what produces the ~166 requests/second offered at the
 * plateau; the multiplier lands on concurrent employee-equivalents (VUs) and
 * therefore on aggregate arrival rate together.
 *
 * Shape: ramp 0 -> full VU count, hold the plateau, ramp down. Credential
 * work never enters the measurement: every account is signed in once in
 * setup() and each VU reuses that session cookie for its whole life, so
 * argon2 cost is absent from the traffic under test.
 *
 * Punch sequencing: an employee may hold at most one open attendance session,
 * so a VU tracks whether its own employee is clocked in and alternates
 * masuk/pulang. The first iteration reads punch state instead of assuming a
 * clean slate, and a 409 re-syncs the local belief from the machine code so a
 * single race cannot cascade into repeated refusals. Every punch carries a
 * fresh idempotency key; keys encode clock, VU id and a per-VU turn counter,
 * so they never repeat inside a run and never collide across VUs.
 *
 * Traffic goes to K6_BASE_URL (default http://localhost:8080). Sign-ins go to
 * K6_IDENTITY_URL when set, which lets one run reach the attendance and
 * identity containers directly over their compose network (for example
 * http://attendance-service:3002 plus http://identity-service:3001) instead of
 * through a port-forwarding layer, which cannot hold thousands of concurrent
 * keep-alive connections. A run can end with fixture sessions still open;
 * teardown() clocks every fixture employee out through the API before the
 * test finishes, and the fixture rows themselves are removed by
 * load/cleanup.sql afterwards.
 *
 * Tunables (environment):
 *   EMPLOYEE_ACCOUNTS  VUs and sign-ins performed in setup   (default 5000)
 *   THINK_SECONDS      pause after each punch+summary pair   (default 60)
 *   RAMP_UP/HOLD/RAMP_DOWN/GRACEFUL_RAMP_DOWN  stage shape  (1m/2m/30s/90s)
 *   SETUP_TIMEOUT     budget for the setup() sign-ins       (default 5m)
 *   TEARDOWN_TIMEOUT  budget for the teardown() clock-outs  (default 10m)
 *   K6_BASE_URL        punch/summary origin                  (default http://localhost:8080)
 *   K6_IDENTITY_URL    sign-in origin (falls back to K6_BASE_URL)
 *   HTTP_TIMEOUT       per-request client timeout               (default 30s)
 *   LOADTEST_PASSWORD  fixture account password             (default LoadTest!2026)
 */

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:8080';
const IDENTITY_URL = __ENV.K6_IDENTITY_URL || BASE_URL;
/** A server that stops answering fails the request instead of hanging a VU. */
const HTTP_TIMEOUT = __ENV.HTTP_TIMEOUT || '30s';
const PASSWORD = __ENV.LOADTEST_PASSWORD || 'LoadTest!2026';

const EMPLOYEE_ACCOUNTS = Number(__ENV.EMPLOYEE_ACCOUNTS || 5000);
const THINK_SECONDS = Number(__ENV.THINK_SECONDS || 60);
const RAMP_UP = __ENV.RAMP_UP || '1m';
const HOLD = __ENV.HOLD || '2m';
const RAMP_DOWN = __ENV.RAMP_DOWN || '30s';
const GRACEFUL_RAMP_DOWN = __ENV.GRACEFUL_RAMP_DOWN || '90s';

/** Sign-ins per batch while setup warms the session pool. */
const LOGIN_BATCH = 100;
/** State/clock-out calls per batch in teardown. */
const CLOSE_BATCH = 200;

/**
 * Every non-200 answer, broken down by endpoint and status code, so a failing
 * run shows which refusal it hit rather than only a failed-request rate. One
 * virtual user out of every five hundred also echoes a sample answer (status
 * plus body) to the console, so samples cover the whole VU range while the
 * console stays readable.
 */
const badResponses = new Counter('bad_responses');

function recordBad(res, endpoint) {
  badResponses.add(1, { endpoint, code: String(res.status) });
  if ((__VU || 0) % 500 === 7) {
    const body = String(res.body || '').replace(/\s+/g, ' ').slice(0, 140);
    console.error(`vu=${__VU} ${endpoint} HTTP ${res.status}: ${body}`);
  }
}

/** Fixture addresses share the marker prefix the SQL fixtures are scoped to. */
const emailOf = (n) => `loadtest-${String(n).padStart(5, '0')}@loadtest.invalid`;

export const options = {
  // Signing every fixture account in takes about two minutes at 5,000
  // accounts; k6 otherwise aborts setup at its 60 second default.
  setupTimeout: __ENV.SETUP_TIMEOUT || '5m',
  // Clocking out 5,000 fixture employees after the run takes longer than
  // k6's 60 second teardown default; a truncated teardown would leave
  // fixture sessions open behind us.
  teardownTimeout: __ENV.TEARDOWN_TIMEOUT || '10m',
  scenarios: {
    punch_summary: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: EMPLOYEE_ACCOUNTS },
        { duration: HOLD, target: EMPLOYEE_ACCOUNTS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: GRACEFUL_RAMP_DOWN,
    },
  },
  thresholds: {
    // The latency budget applies to the whole measured workload ...
    'http_req_duration{scenario:punch_summary}': ['p(95)<300'],
    // ... and to each of the two interactions it is stated for, separately.
    'http_req_duration{scenario:punch_summary,endpoint:punch}': ['p(95)<300'],
    'http_req_duration{scenario:punch_summary,endpoint:summary}': ['p(95)<300'],
    // Setup sign-ins and teardown clock-outs are requests too: nothing may fail.
    http_req_failed: ['rate==0'],
  },
};

/** Reads the sid cookie a successful sign-in answers with. */
function sessionIdFrom(response) {
  const jar = response.cookies;
  if (!jar || !jar.sid || jar.sid.length === 0) {
    return null;
  }
  return jar.sid[0].value;
}

export function setup() {
  if (!Number.isInteger(EMPLOYEE_ACCOUNTS) || EMPLOYEE_ACCOUNTS < 1) {
    throw new Error(`EMPLOYEE_ACCOUNTS must be a positive integer, got ${EMPLOYEE_ACCOUNTS}`);
  }
  const cookies = [];
  for (let first = 1; first <= EMPLOYEE_ACCOUNTS; first += LOGIN_BATCH) {
    const batch = [];
    const numbers = [];
    for (let n = first; n < first + LOGIN_BATCH && n <= EMPLOYEE_ACCOUNTS; n += 1) {
      batch.push([
        'POST',
        `${IDENTITY_URL}/api/identity/auth/login`,
        JSON.stringify({ email: emailOf(n), password: PASSWORD }),
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: HTTP_TIMEOUT,
          tags: { endpoint: 'login', name: 'login' },
        },
      ]);
      numbers.push(n);
    }
    const responses = http.batch(batch);
    responses.forEach((response, i) => {
      const label = numbers[i];
      if (response.status !== 200) {
        throw new Error(`sign-in for fixture account #${label} answered HTTP ${response.status}`);
      }
      const sid = sessionIdFrom(response);
      if (sid === null) {
        throw new Error(`sign-in for fixture account #${label} set no sid cookie`);
      }
      cookies.push(sid);
    });
  }
  return { cookies };
}

/** One VU owns one fixture account; state below is per VU. */
let sessionOpen = false;
let bootstrapped = false;
let turnCounter = 0;

const hex = (value, width) => Math.floor(value).toString(16).padStart(width, '0').slice(-width);

/**
 * Idempotency key for one logical punch. The clock separates reruns, the VU id
 * separates accounts and the turn counter separates punches inside one VU, so
 * no key can be replayed against another row or another run.
 */
function punchKey() {
  turnCounter += 1;
  const clock = hex(Date.now(), 12);
  const owner = hex(__VU || 0, 4);
  const noise = hex(Math.floor(Math.random() * 0x100000000), 8);
  return `${clock.slice(0, 8)}-${clock.slice(8, 12)}-4${noise.slice(0, 3)}-${owner}-${hex(
    turnCounter,
    4,
  )}${noise}`;
}

export default function (setupData) {
  const cookies = setupData.cookies;
  if (__VU < 1 || __VU > cookies.length) {
    throw new Error(`virtual user ${__VU} has no fixture session; provision ${__VU} accounts`);
  }
  const sid = cookies[__VU - 1];
  if (typeof sid !== 'string' || sid.length < 20) {
    throw new Error(`virtual user ${__VU} holds no usable fixture session value`);
  }
  const cookie = `sid=${sid}`;

  if (!bootstrapped) {
    const state = http.get(`${BASE_URL}/api/attendance/punches/state`, {
      headers: { Cookie: cookie },
      timeout: HTTP_TIMEOUT,
      tags: { endpoint: 'punch_state', name: 'punch-state' },
    });
    check(state, { 'punch state is readable': (r) => r.status === 200 });
    if (state.status !== 200) {
      recordBad(state, 'punch_state');
    }
    // The state body is {"status":"bekerja"|"belum_masuk", ...}: a plain
    // substring test answers "is this employee clocked in" without a parser.
    sessionOpen = state.status === 200 && (state.body || '').indexOf('"bekerja"') !== -1;
    bootstrapped = true;
  }

  const direction = sessionOpen ? 'pulang' : 'masuk';
  const punch = http.post(
    `${BASE_URL}/api/attendance/punches`,
    JSON.stringify({ direction }),
    {
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'Idempotency-Key': punchKey(),
      },
      timeout: HTTP_TIMEOUT,
      tags: { endpoint: 'punch', name: 'punch' },
    },
  );
  check(punch, { 'punch is accepted': (r) => r.status === 200 });
  if (punch.status !== 200) {
    recordBad(punch, 'punch');
  }
  if (punch.status === 200) {
    sessionOpen = direction === 'masuk';
  } else if (punch.status === 409) {
    // Refused because the real state differs from the local belief: adopt the
    // server's answer so the next iteration asks for the other direction.
    sessionOpen = (punch.body || '').indexOf('SESSION_ALREADY_OPEN') !== -1;
  }

  const customRange = __ITER % 2 === 1;
  let summaryUrl = `${BASE_URL}/api/attendance/summary`;
  if (customRange) {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    summaryUrl = `${summaryUrl}?from=${from}&to=${to}`;
  }
  const summary = http.get(summaryUrl, {
    headers: { Cookie: cookie },
    timeout: HTTP_TIMEOUT,
    tags: { endpoint: 'summary', name: customRange ? 'summary-range' : 'summary-default' },
  });
  check(summary, { 'summary is readable': (r) => r.status === 200 });
  if (summary.status !== 200) {
    recordBad(summary, 'summary');
  }

  sleep(THINK_SECONDS + THINK_SECONDS * 0.2 * Math.random());
}

/**
 * Clocks every fixture employee out before the test ends, so a finished run
 * never leaves open attendance sessions behind. State reads decide who is
 * still clocked in, which keeps every clock-out answer at 200 and therefore
 * keeps the zero-failed-requests budget intact.
 */
export function teardown(setupData) {
  const cookies = setupData.cookies;
  let closed = 0;
  for (let first = 0; first < cookies.length; first += CLOSE_BATCH) {
    const slice = [];
    for (let i = first; i < first + CLOSE_BATCH && i < cookies.length; i += 1) {
      slice.push(i);
    }
    const stateBatch = slice.map((i) => [
      'GET',
      `${BASE_URL}/api/attendance/punches/state`,
      null,
      { headers: { Cookie: `sid=${cookies[i]}` }, timeout: HTTP_TIMEOUT, tags: { endpoint: 'teardown', name: 'punch-state' } },
    ]);
    const open = [];
    let stateFailures = 0;
    http.batch(stateBatch).forEach((response, j) => {
      if (response.status !== 200) {
        recordBad(response, 'teardown_state');
        if (stateFailures < 3) {
          const body = String(response.body || '').replace(/\s+/g, ' ').slice(0, 140);
          console.error(`teardown: state for account #${slice[j] + 1} HTTP ${response.status}: ${body}`);
        }
        stateFailures += 1;
      }
      if (response.status === 200 && (response.body || '').indexOf('"bekerja"') !== -1) {
        open.push(slice[j]);
      }
    });
    if (open.length === 0) {
      continue;
    }
    const closeBatch = open.map((i) => [
      'POST',
      `${BASE_URL}/api/attendance/punches`,
      JSON.stringify({ direction: 'pulang' }),
      {
        headers: {
          'Content-Type': 'application/json',
          Cookie: `sid=${cookies[i]}`,
          'Idempotency-Key': punchKey(),
        },
        timeout: HTTP_TIMEOUT,
        tags: { endpoint: 'teardown', name: 'punch' },
      },
    ]);
    http.batch(closeBatch).forEach((response, j) => {
      if (response.status === 200) {
        closed += 1;
      } else {
        recordBad(response, 'teardown_punch');
        console.error(`teardown: clock-out for account #${open[j] + 1} answered HTTP ${response.status}`);
      }
    });
  }
  console.log(`teardown: clocked out ${closed} fixture employee(s)`);
}
