# Load suite: punch + summary

K6 scenario for punch and summary traffic at ten times the worst-case company
size (500 employee accounts -> 5,000 virtual users, one fixture account per
virtual user). The measured budget is p95 < 300 ms per interaction and zero
failed requests.

| File | Purpose |
|---|---|
| `punch-summary.js` | k6 scenario: ramp-up, plateau, ramp-down over punch + summary traffic |
| `seed.js` | provisions / removes the `loadtest-*` fixture accounts |
| `cleanup.sql` | SQL half of the teardown: fixture attendance rows + employees |

## 1. Provision fixtures

```bash
node load/seed.js provision        # 5000 fixture employees, all clocked out
node load/seed.js provision 10     # smaller pool for a smoke run
```

Requires the local stack (container `infra-postgres-main-1`, container
`infra-redis-1`) and `argon2` from this package's `node_modules`.

## 2. Run the scenario

The host edge port is carried by a multiplexed tunnel that collapses under
thousands of concurrent keep-alive connections (it starts resetting new
connections once roughly a thousand are open), and a k6 container inside the
virtual machine competes with the stack for memory. The supported high-
concurrency path therefore runs k6 on the host in front of a local forwarder
that pools the tunnel's connection count:

```bash
node load/edge-proxy.js &        # 127.0.0.1:18080 -> edge :8080, 150 sockets
k6 run load/punch-summary.js     # K6_BASE_URL=http://127.0.0.1:18080
```

Or point `K6_BASE_URL` at the edge directly for small runs:

```bash
k6 run load/punch-summary.js     # defaults to http://localhost:8080
```

A k6 container on the compose network also works when the virtual machine has
enough spare memory (a 5,000 VU container needs roughly 3 GiB on top of the
stack):

```bash
docker run --rm --network infra_default \
  -e K6_BASE_URL=http://attendance-service:3002 \
  -e K6_IDENTITY_URL=http://identity-service:3001 \
  -v "$PWD/load:/load:ro" \
  grafana/k6:latest run /load/punch-summary.js
```

Environment knobs (defaults produce the full 10x run):

| Variable | Default | Meaning |
|---|---|---|
| `EMPLOYEE_ACCOUNTS` | `5000` | VUs ramped and signed in during setup |
| `THINK_SECONDS` | `60` | pause after each punch + summary pair (plus 20% jitter) |
| `RAMP_UP` / `HOLD` / `RAMP_DOWN` | `1m` / `2m` / `30s` | stage shape |
| `GRACEFUL_RAMP_DOWN` | `90s` | time given to in-flight iterations |
| `SETUP_TIMEOUT` | `5m` | budget for the setup() sign-ins |
| `TEARDOWN_TIMEOUT` | `10m` | budget for the teardown() clock-outs |
| `K6_BASE_URL` | `http://localhost:8080` | punch/summary origin |
| `K6_IDENTITY_URL` | value of `K6_BASE_URL` | sign-in origin (point it at `identity-service:3001` when the base URL is attendance-only) |
| `HTTP_TIMEOUT` | `30s` | per-request client timeout; a hung server fails the request instead of hanging the run |
| `LOADTEST_PASSWORD` | `LoadTest!2026` | fixture password (must match `seed.js`) |

`edge-proxy.js` knobs: `PROXY_LISTEN` (default `18080`), `PROXY_TARGET`
(default `8080`), `PROXY_MAX_SOCKETS` (default `150`).

Example smoke run (10 accounts, short stages) through the proxy:

```bash
node load/edge-proxy.js &
K6_BASE_URL=http://127.0.0.1:18080 EMPLOYEE_ACCOUNTS=10 THINK_SECONDS=2 \
  RAMP_UP=5s HOLD=15s RAMP_DOWN=5s GRACEFUL_RAMP_DOWN=20s \
  k6 run load/punch-summary.js
```

Thresholds evaluated by k6 (a non-zero exit code means at least one was
crossed):

```js
'http_req_duration{scenario:punch_summary}':            ['p(95)<300'],
'http_req_duration{scenario:punch_summary,endpoint:punch}':   ['p(95)<300'],
'http_req_duration{scenario:punch_summary,endpoint:summary}': ['p(95)<300'],
'http_req_failed': ['rate==0'],
```

Setup sign-ins and teardown clock-outs are tagged `login`/`teardown` and sit
outside the scenario tag, so they never dilute the latency budget; they do
count towards `http_req_failed`, because nothing may fail.

## 3. Tear down

```bash
k6 run load/punch-summary.js        # its teardown() already clocks everyone out
node load/seed.js cleanup           # then remove the fixture rows themselves
```

Verify nothing is left:

```bash
docker exec infra-postgres-main-1 psql -U wfh -d wfh_main -t -A \
  -c "SELECT count(*) FROM employees WHERE email LIKE 'loadtest-%@loadtest.invalid';"
```
