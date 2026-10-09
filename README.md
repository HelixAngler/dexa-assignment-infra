# infra

Edge routing (Caddy), the 12-service compose stack, the two Prisma schemas, and the
e2e / load / security suites for this workspace.

Everything below was executed on this machine (Docker context `rancher-desktop`,
Node `v22.17.0`, Compose `v5.3.1`) and re-executed against the live 12-container
stack for this revision on 2026-10-09. Commands run from `sources/infra` unless a
block says otherwise. Every block was run here and exits `0`; the few that were
skipped, or run in a variant, say so in place.

## 1. Prerequisites

- **Docker with Compose v2** — `docker compose version`. On this machine Docker comes
  from Rancher Desktop; check the active context with `docker context ls` (this
  machine shows `rancher-desktop *`).
- **Node 22 + npm** — verified with `v22.17.0`.
- A checkout that already contains every `sources/<name>` directory: Compose builds
  the five application images from `../<name>` contexts, so an empty submodule
  directory means the build fails.

### Ports

| Host port | What |
|---|---|
| **8080** | Caddy edge, HTTP — **the entrypoint for the whole stack**. `/hrd` here serves the HRD console, every other path serves the employee app, `/api/*` is proxied to the three services |
| 8443 | Caddy edge, HTTPS (certificates from Caddy's internal CA) |
| 8081 / 8082 | `employee-web` / `hrd-web` published straight onto the host (debugging only) |
| 3001 / 3002 / 3003 | `identity-service` / `attendance-service` / `notification-service` published straight onto the host (debugging only) |
| 5432 / 5433 | PostgreSQL main / log |
| 6379 | Redis |
| 8000 | Centrifugo |
| 9000 / 9001 | MinIO API / console |
| 9092 / 9644 | Redpanda Kafka API / admin API |

## 2. Environment

`.env.example` is the authoritative variable list. **The compose file bakes in working
defaults for everything the containers need, so `docker compose up -d` needs no `.env`
at all** — that is how the stack runs on this machine.

The only variables a *host-side* process needs are the two database URLs read by
`scripts/migrate.sh` and `scripts/seed.ts`; they run on the host, so they must go
through the published ports:

```bash
export DATABASE_URL_MAIN=postgres://wfh:wfh@localhost:5432/wfh_main
export DATABASE_URL_LOG=postgres://wfh:wfh@localhost:5433/wfh_log
```

The file-based alternative is `cp .env.example .env` — both scripts read
`sources/infra/.env` when it exists (`seed.ts` only fills in variables you have not
already exported; `migrate.sh` sources the file itself). Not executed as written
during this documentation pass: **do not leave that file in place before (re)starting
Compose**. Compose interpolates its own `${...}` placeholders from the same file, and
every URL in `.env.example` points at `localhost`, which from inside a container is
the container itself — verified with `docker compose --env-file .env.example config`,
which hands the services `DATABASE_URL=postgres://…@localhost:5432/wfh_main`. The
commands below therefore export the two URLs instead of creating `.env`.

What the variables mean:

| Variable | Meaning |
|---|---|
| `DATABASE_URL_MAIN` | Main domain DB (employees, sessions, attendance). Host: `localhost:5432`; inside the compose network: `postgres-main:5432` |
| `DATABASE_URL_LOG` | Append-only log DB (profile-change log). Host: `localhost:5433`; inside the compose network: `postgres-log:5432` |
| `REDIS_URL` | Sessions, counters and caches. Host: `localhost:6379`; in-network: `redis:6379` |
| `INTERNAL_API_TOKEN` | Shared secret sent as `X-Internal-Token` by `identity-service` when it calls `attendance-service`'s internal endpoints. **Both containers must be given the same value**, or those calls are rejected |
| `CENTRIFUGO_API_KEY` | One value, two jobs: the gateway's HTTP-API key *and* the HMAC secret that browser connection JWTs are signed with. `notification-service` and the Centrifugo container must agree on it, otherwise no browser ever connects |
| `ATTENDANCE_INTERNAL_URL` | How `identity-service` reaches attendance's internal endpoint (`http://attendance-service:3002` in-network) |
| `REDPANDA_BROKERS`, `CENTRIFUGO_URL`, `MINIO_*`, `SESSION_SECRET`, `PORT_*` | Remaining connection details and ports — see `.env.example` |

Every value has a usable default: `docker-compose.yml` carries a `${VAR:-fallback}`
for everything it passes into a container, so nothing in this section is required in
order to start the stack.

## 3. Start the stack

```bash
docker compose up -d
docker compose ps
```

The twelve services: `postgres-main`, `postgres-log`, `redis`, `minio`, `redpanda`,
`centrifugo`, `identity-service`, `attendance-service`, `notification-service`,
`employee-web`, `hrd-web`, `caddy`. The first run builds five images and takes a few
minutes; later runs start from cache.

`docker compose ps` should list all twelve as `Up`, with `postgres-main`,
`postgres-log` and `redis` reporting `healthy` (they are the only ones with a
healthcheck). Then probe the three APIs through the edge:

```bash
curl -fsS http://localhost:8080/api/identity/health
curl -fsS http://localhost:8080/api/attendance/health
curl -fsS http://localhost:8080/api/notification/health
```

Each answers `200` with `{"status":"ok","service":"<name>-service"}`. The edge itself:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/      # 200 employee app
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/hrd   # 302 -> /hrd/
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/hrd/  # 200 HRD console
```

On a fresh checkout the database is still empty at this point: the stack is up but
nobody can sign in until you seed (section 4).

## 4. Database: migrate + seed

Both steps are **safe to re-run against a live stack** — neither drops anything.
Migrations go through `prisma migrate deploy`, which records what it applied and only
applies what is missing; the seed upserts on the unique company email, so a rerun
never creates duplicates. Keep the exports from section 2 in the same shell.

```bash
bash scripts/migrate.sh   # alias: npm run db:migrate
npm run db:seed
```

Both exit `0` — re-run for this revision against the already-migrated, already-seeded
stack. Re-running `migrate.sh` on an already-current database prints
`No pending migrations to apply` for each schema and still exits `0`. The seed
prints **every** account it finds in the main database with its password, headed by
`seed.ts: <n> account(s) present in the main database`. On a freshly seeded database
`<n>` is `6`; it is larger on a stack that has run the suites, because those leave
fixture accounts behind (`us4-crud-*@example.com` from the e2e console journey,
`outbox-*@example.test` from the notification unit suite) and the seed never deletes
anything — it only upserts the six rows it owns.

Seeded logins:

| Email | Role | Status | Password |
|---|---|---|---|
| `ivan@company.com` | hrd | active | `HrdAdmin!2026` |
| `ada@company.com` | employee | active | `EmployeeDemo!2026` |
| `bo@company.com` | employee | active | `EmployeeDemo!2026` |
| `cleo@company.com` | employee | active | `EmployeeDemo!2026` |
| `dan@company.com` | employee | deactivated | `EmployeeDemo!2026` |
| `eka@company.com` | employee | active, must change password | `TempFirst!2026` |

## 5. Validate

### Per package

Each application submodule owns its own suite:

```bash
# from sources/<name>, for each of
# identity-service attendance-service notification-service employee-web hrd-web
npm run lint
npm test          # jest --runInBand in the services, vitest in the SPAs
npm run build
```

Two of those suites share state with the running stack and both assume **no outbox
poller is running**:

- `identity-service` writes `profile_change_events` rows into the live main DB and
  asserts they are still unpublished (`publishedAt: null`).
- `notification-service` publishes into the live broker and asserts that a freshly
  published event has not been consumed yet.

The compose `notification-service` is exactly that poller/consumer, so while it runs
it wins the race and those assertions fail (intermittently for `identity-service`,
deterministically for `notification-service`). Stop it for the unit-test phase:

```bash
docker compose stop notification-service
# ... run npm test in sources/identity-service and sources/notification-service ...
docker compose start notification-service
```

`attendance-service`, `employee-web` and `hrd-web` need no such precaution.

Executed for this revision: the full `attendance-service` triple (`npm run lint`,
`npm test` — 251 tests in 12 suites — and `npm run build`, each exit `0`) plus
`npm run lint` and `npm run build` for `notification-service` (both exit `0`). The
other three packages are documented from their `scripts` entries (`jest --runInBand`
in the services, `vitest run` in the SPAs, `tsc && vite build` in the SPAs), and the
notification unit suite itself was not re-run here because it needs the
stopped-poller state above, which takes the stack's realtime pipeline down for the
duration.

### This package

```bash
npm run lint        # eslint over tooling/ e2e/ scripts/ load/
npm run typecheck   # tsc --noEmit; `npm test` is an alias for it
npm run i18n        # locale key parity between employee-web and hrd-web
```

### End-to-end

```bash
npx playwright test        # stack must be up; 23 tests in 9 files, serial, ~1 min
```

`npm run e2e` runs the identical set through the package script (re-run for this
revision: `npx playwright test` and `npm run e2e` both report `23 passed` and exit
`0`, ~1 min each). The runner is configured for `E2E_BASE_URL` (default
`http://localhost:8080`), so point that at another edge port if you moved it.

### Fast smoke

```bash
curl -fsS http://localhost:8080/api/identity/health >/dev/null &&
curl -fsS http://localhost:8080/api/attendance/health >/dev/null &&
curl -fsS http://localhost:8080/api/notification/health >/dev/null &&
npm run e2e:smoke
```

`e2e:smoke` is one read-only browser journey (sign in, reach the punch button) in
both viewports — 2 tests, a couple of seconds, no attendance rows written. The whole
line re-run for this revision: `2 passed`, exit `0`.

### Full gate

```bash
docker compose stop notification-service     # unit suites assume no outbox poller
npm run lint && npm run typecheck && npm run i18n
for d in identity-service attendance-service notification-service employee-web hrd-web; do
  ( cd "../$d" && npm run lint && npm test && npm run build ) || exit 1
done
docker compose start notification-service    # e2e needs the realtime pipeline
npx playwright test
```

For this revision the block ran in pieces: the middle
`npm run lint && npm run typecheck && npm run i18n` (exit `0`), the
`attendance-service` pass of the loop (exit `0`), and the final
`npx playwright test` (exit `0`). The `stop`/`start` pair and the remaining loop
passes were skipped — see "Per package" above for exactly what ran and why — so run
the block as one line on a quiet machine.

### Optional: load and security

- **k6** — topology, fixture provisioning, thresholds and the container variant are in
  [`load/README.md`](load/README.md); the proven high-concurrency path is
  `node load/edge-proxy.js &` in front of `k6 run load/punch-summary.js`.
  Not wrapped as an npm script, because k6 is not installed by `npm install` here
  (no `k6` binary on this machine either — the `grafana/k6:latest` image is, so the
  container variant in that README runs without installing anything).
- **ZAP** — the runnable `docker run ... zap.sh -autorun ...` invocations, exit-code
  semantics and report locations are in the header comments of
  [`security/zap-baseline.yaml`](security/zap-baseline.yaml) (crawl + passive) and
  [`security/zap-config.yaml`](security/zap-config.yaml) (adds the active scanner).
  Reports land in `security/reports/`. Also deliberately not an npm script; the
  `ghcr.io/zaproxy/zaproxy:stable` image is already on this machine.

Neither optional suite was executed for this revision — both are documented from
the sources named above and both are Docker-invoked, so nothing else has to be
installed to run them.

## 6. Day-2 ops

```bash
docker compose up -d --build <service>   # rebuild one service from source, then restart it
docker compose logs -f <service>         # follow one service's logs (Ctrl-C to stop)
```

A rebuild only recreates that one container; the databases and the edge stay up.
Verified with `docker compose up -d --build attendance-service` (exit `0`, container
recreated, health `200` again) and with `docker compose logs --tail 3 identity-service`
— the same read path as `-f`, which only differs by following the stream until you
interrupt it.

### Stopping, and what `-v` costs

```bash
docker compose down       # stop and remove the containers; named volumes SURVIVE
docker compose down -v    # ALSO deletes the named volumes
```

The named volumes are `postgres-main-data`, `postgres-log-data`, `minio-data`,
`caddy-data` and `caddy-config` — `docker volume ls` shows them prefixed with the
compose project name: `infra_postgres-main-data`, `infra_postgres-log-data`,
`infra_minio-data`, `infra_caddy-data`, `infra_caddy-config`. Plain
`docker compose down` keeps all of them, so the next `up` finds the same data.
Adding `-v` deletes them: both databases, every MinIO
object and the local CA are gone for good, and you are back at section 3 + 4.

Neither form was executed during this pass — `down` would tear down the stack other
work is running on. The inverse, `docker compose up -d`, exits `0`.

### Where migrations live

- `prisma/main/migrations/` — main domain schema (`prisma/main/schema.prisma`)
- `prisma/log/migrations/` — log schema (`prisma/log/schema.prisma`)

Both directories currently hold a single `0_init/`. A new migration is added to the
matching directory and picked up by the next `bash scripts/migrate.sh` run. The
generated Prisma clients are committed into the service submodules; regenerate them
after a schema change with `npm run db:generate` (not re-run during documentation —
it rewrites generated client files committed inside the service submodules).

### How seed idempotency works

`scripts/seed.ts` upserts each of the six accounts on its unique `email`. A rerun
therefore (a) never adds a seventh row, and (b) **resets** those six accounts to the
script's values — name, position, phone, role, status and password hash. That makes
`npm run db:seed` the standard way to undo a local password/role change on a seeded
account.

### Reset all data

Destroys every row; the containers keep running:

```bash
docker exec infra-postgres-main-1 psql -U wfh -d postgres \
  -c 'DROP DATABASE wfh_main WITH (FORCE);' -c 'CREATE DATABASE wfh_main OWNER wfh;'
docker exec infra-postgres-log-1 psql -U wfh -d postgres \
  -c 'DROP DATABASE wfh_log WITH (FORCE);' -c 'CREATE DATABASE wfh_log OWNER wfh;'

bash scripts/migrate.sh     # DATABASE_URL_MAIN / DATABASE_URL_LOG exported
npm run db:seed
docker exec infra-redis-1 redis-cli flushall
```

Not re-run during documentation — it destroys the shared stack's data. Supporting
checks: `wfh` is the superuser on both instances (`rolsuper = t`), so the
drop/create succeeds as written; `migrate.sh` and `db:seed` were re-executed for
this revision and exit `0`; `docker exec infra-redis-1 redis-cli dbsize` reaches
the Redis CLI (exit `0`), so the `flushall` line runs the same way — it was left
out only because it signs every session out of the stack. Redpanda retains
old topic history, so a consumer restarted after this reset can still replay events
whose employees no longer exist (they are idempotent per `event_id`, but they will
show up in the fresh log table).

## 7. CI

`.github/workflows/ci.yml` (this submodule's only workflow) is triggered by both
`push` and `pull_request`. Two facts about where it can run: GitHub loads workflows
only from a repository's root `.github/workflows/`, and every step addresses its
packages as `sources/<name>/` — so the paths resolve only in a checkout that contains
the `sources/` tree.

| Job | What it runs | Gates |
|---|---|---|
| `lint` | `npm run lint` in each of the six packages (matrix, `fail-fast: false`) | Any package's linter output |
| `unit` | `npm test` in each of the six packages (matrix, `fail-fast: false`) | Jest/Vitest suites in the applications; in `infra` this is the TypeScript check |
| `e2e` | `docker compose up -d --build`, wait 45 s, `npm ci`, `npx playwright test`, then `docker compose down -v` in `if: always()` | The browser journeys against a freshly built stack |
| `i18n-parity` | `npm run i18n` (skipped when the script is absent) | Locale key parity between the two SPAs |
| `k6` | Compose up, installs k6 from the k6 apt repo, `K6_BASE_URL=http://localhost:80 k6 run sources/infra/load/punch-summary.js`, then `docker compose down -v` | Conditional on `load/punch-summary.js` existing; p95 < 300 ms and zero failed requests |
| `dependency-scan` | `npm audit --audit-level=high` in all six packages (blocking), then OSV-Scanner over `sources/` with `continue-on-error: true` | Any high or critical advisory fails the job; OSV findings are advisory only |
