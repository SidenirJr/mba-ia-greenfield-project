# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, Redis, object storage, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

**Explicit exception — `video-worker`:** `docker compose up -d` also starts the `video-worker` service (`npm run start:worker`, the queue consumer). It is part of the environment, not the application server, so it is allowed to autostart. It must be **stopped while test suites run** (see "Test execution").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Object storage (`minio`):** `docker compose exec minio curl -f http://localhost:9000/minio/health/live` — expect HTTP 200
- **`minio-init`:** one-shot — `docker compose ps -a` must show it as `Exited (0)` (it creates the bucket and its CORS and exits)
- **`video-worker`:** `docker compose ps` must show it `running`; `docker compose logs video-worker` shows the worker booting

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

First time: `cp .env.example .env` (the `.env` is git-ignored; when a new variable is added to `.env.example`, update your local `.env` too). The `S3_*` credentials have no usable default — the API fails at boot without them.

Services (`compose.yaml`):
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — queue consumer + sweeper (`npm run start:worker`), same image as the API, no published ports
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP `1025`, UI `8025`
- `minio` — S3-compatible object storage running the `pgsty/silo` image (a fork of MinIO, which satisfies the project's "S3/MinIO" requirement); S3 API on `9000`, console on `9001`; credentials from `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`; volume `minio-data`
- `minio-init` — one-shot `pgsty/mc` container that creates the bucket (`S3_BUCKET`) and sets its CORS (exposes `ETag` for browser multipart uploads); exits 0 and is a dependency of `nestjs-api` and `video-worker`
- `redis` — Redis 7 (BullMQ queues; `noeviction`, AOF on; volume `redis-data`). **Never publish its port on the host** — port 6379 is taken by other containers; it is reached as `redis:6379` from inside the Compose network

The API image (`Dockerfile.dev`) includes `ffmpeg`/`ffprobe` (used by the worker and by the test fixtures).

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker                     # Video worker in watch mode (Compose service `video-worker`; output in dist-worker/, entry src/worker.ts)
npm run migration:run                    # Apply TypeORM migrations
npm run openapi:export                   # Regenerate openapi.json (commit the result)

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e -- --runInBand
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

**Stop the `video-worker` before running any suite** and start it again afterwards. The container's worker and sweeper compete with the suites for the shared database and Redis (the suites truncate tables and seed videos concurrently):

```bash
docker compose stop video-worker
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e -- --runInBand
docker compose up -d video-worker       # confirm with `docker compose ps`
```

Integration/e2e tests use the real Compose services (`db`, `redis`, `minio`, `ffmpeg`): each suite creates its own bucket (`test-<uuid>`) and queue prefix, and the `test/video-pipeline.e2e-spec.ts` runs `AppModule` and `WorkerModule` in the same process. `@nestjs/bullmq` and `@nestjs/bull-shared` are ESM-only, so the Jest configs (`package.json` and `test/jest-e2e.json`) keep a restricted `transformIgnorePatterns` + `transform` for these two packages — do not remove them.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.
- `transformIgnorePatterns` + `transform` for `@nestjs/bullmq` / `@nestjs/bull-shared` (ESM-only packages compiled by `ts-jest`) — without them Jest fails with `Unexpected token 'export'`.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Environment Variables (video pipeline)

Defined in `.env.example` and validated by Joi in `src/config/env.validation.ts` (the app fails at boot on invalid values). Hosts are Compose service names.

| Variable | Default | Meaning |
|----------|---------|---------|
| `S3_ENDPOINT` | `http://minio:9000` | Internal storage endpoint (API and worker) |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | Host that presigned URLs are signed for (reachable by the browser) |
| `S3_REGION` | `us-east-1` | Signing region |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` | required | Credentials and bucket (also used by `minio` / `minio-init`) |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style addressing |
| `PRESIGN_EXPIRES_SECONDS` | `900` | Presigned URL lifetime |
| `REDIS_HOST`, `REDIS_PORT` | `redis`, `6379` | BullMQ connection |
| `QUEUE_PREFIX` | `streamtube` | BullMQ key prefix |
| `UPLOAD_MAX_BYTES` | `10737418240` (10 GiB) | Maximum declared video size |
| `UPLOAD_PART_SIZE_BYTES` | `67108864` (64 MiB) | Multipart part size (S3 minimum 5 MiB, at most 10000 parts) |
| `UPLOAD_EXPIRATION_HOURS` | `24` | Draft/upload lifetime before the sweeper aborts it |
| `SWEEPER_INTERVAL_MS` | `300000` | Sweeper schedule |
| `PROCESSING_STALE_MS` | `3600000` | Age after which a `processing` video is re-enqueued |
| `FFMPEG_TIMEOUT_MS` | `600000` | Timeout per `ffprobe`/`ffmpeg` call |

## Video Pipeline

- API (`src/videos`): `POST /videos` creates the draft and opens an S3 multipart upload; the client PUTs parts straight to the storage using presigned URLs; `POST /videos/:id/upload/complete` checks the object size, moves the video to `processing` and enqueues a `video.process` job (`jobId = process-video-<uuid>`, 3 attempts, exponential backoff) on the `video-processing` BullMQ queue. `stream`/`download` are public `302` redirects to presigned `GetObject` URLs of `ready` videos.
- Worker (`src/worker.ts` → `WorkerModule`): the **only** module with `@Processor`s — the API process never consumes jobs. It runs `ffprobe` (duration and metadata) and `ffmpeg` (thumbnail) and sets the video to `ready` or `error` (`UNREADABLE_MEDIA`, `THUMBNAIL_FAILED`, `PROCESSING_FAILED`). A job scheduler on the `video-maintenance` queue runs the sweeper every `SWEEPER_INTERVAL_MS`.
- Storage keys: `videos/<uuid>/original` and `videos/<uuid>/thumbnail.jpg`.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
