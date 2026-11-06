---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-05T17:15:29-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-05T17:46:44-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-11-05T17:15:29-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-05T17:15:29-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-05T17:15:29-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-05T17:15:29-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-05T17:15:29-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-05T17:46:44-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-05T17:15:29-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in `docs/project-plan.md`._ Recorded in `docs/decisions/technical-decisions-phase-03-videos.md` (notes, not requirements): visibility public/unlisted, draft → publication flow, title/description/category/custom-thumbnail editing (Phase 04); player UI, view counts, download button (Phase 05); transcoding / HLS / adaptive bitrate (not in any phase bullet — playback serves the original file); frontend upload UI.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `nestjs-project` — not named in `docs/project-plan.md` for this phase; in scope per the decisions doc header (`src/videos/` module, storage and queue integration, worker entrypoint, videos-table migration, Compose services for object storage, queue and worker).

**Deferred subprojects:** `next-frontend` — per the decisions doc header, the video UI (upload/player screens) is out of scope for this phase; no frontend implementation decision is open.

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Job Queue Technology | decided | A | `bullmq@^6.7.0`, `@nestjs/bullmq@^12.0.0`, `ioredis@^5.11.1` |
| phase-03-videos/TD-02 | phase | Cross-layer | Upload Strategy for Files up to 10GB | decided | A | `@aws-sdk/client-s3@^3.1163.0`, `@aws-sdk/s3-request-presigner@^3.1163.0` |
| phase-03-videos/TD-03 | phase | Cross-layer | Presigned URL Host and Endpoint Configuration | decided | A | — |
| phase-03-videos/TD-04 | phase | Backend | Processing Trigger and Job Idempotency | decided | A | — |
| phase-03-videos/TD-05 | phase | Backend | Worker Location and Runtime | decided | A | — |
| phase-03-videos/TD-06 | phase | Backend | Metadata Extraction and FFmpeg Invocation | decided | A | — |
| phase-03-videos/TD-07 | phase | Backend | Public Video Identifier (Unique URL) | decided | A | — |
| phase-03-videos/TD-08 | phase | Cross-layer | Streaming and Download Delivery | decided | A | — |
| phase-03-videos/TD-09 | phase | Backend | Video Status Lifecycle, Failure Handling, Abandoned Uploads | decided | A | — |
| phase-03-videos/TD-10 | phase | Backend | Bucket Layout, Object Keys and Provisioning | decided | A | — |
| phase-03-videos/TD-11 | phase | Backend | Authorization Model | decided | A | — |
| phase-03-videos/TD-12 | phase | Backend | Test Strategy and Fixtures | decided | A | — |
| phase-03-videos/TD-13 | phase | Backend | Object Storage Engine | decided | A | — |
| phase-03-videos/TD-14 | phase | Backend | Thumbnail Frame, Format and Size | decided | A | — |
| phase-03-videos/TD-15 | phase | Backend | Accepted Upload Formats and Content Types | decided | B | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-10, phase-03-videos/TD-12, phase-03-videos/TD-13 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-05, phase-03-videos/TD-09, phase-03-videos/TD-12 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-11, phase-03-videos/TD-12, phase-03-videos/TD-15 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-09, phase-03-videos/TD-11 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-09, phase-03-videos/TD-12, phase-03-videos/TD-15 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-12, phase-03-videos/TD-14 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07, phase-03-videos/TD-12 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08, phase-03-videos/TD-11, phase-03-videos/TD-12 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08, phase-03-videos/TD-11, phase-03-videos/TD-12 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** it is the only option that combines the official Nest integration, built-in retry/backoff/`jobId` dedup, a CJS-safe package, and no unverified glue; the unpublished Redis service avoids the 6379 conflict. Option B is the strongest alternative if the user wants to avoid a Redis container (it fits the Phase 02 "Postgres suffices" stance), but it is ~3 months old and its Nest hook is unverified; because the BullMQ API is identical, A → B later is a small change confined to queue registration. The missing native DLQ is acceptable: the terminal `error` status plus failure reason in the video row (TD-09) is the dead-letter record. Canonical env keys if A is chosen: `REDIS_HOST=redis`, `REDIS_PORT=6379` in Joi schema, `compose.yaml` and `.env.example`.
**Libraries:** `bullmq@^6.7.0`, `@nestjs/bullmq@^12.0.0`, `ioredis@^5.11.1`

### phase-03-videos/TD-02

**Recommendation:** it is the only option where the API does not touch the bytes, it satisfies resume from §4 through `ListParts`, and it matches the architecture diagram and inherited BFF decision. Proposed parameters (all env-configurable): server-chosen part size, default 64 MiB and never below 5 MiB or `ceil(size / 10000)` (10 GiB ⇒ 160 parts, far from the 10,000 cap); declared size validated against `UPLOAD_MAX_BYTES`; the API returns `part_size` and the client must use it. Abandoned uploads: do **not** rely on storage lifecycle alone — S3 and Garage (documented: `AbortIncompleteMultipartUpload` supported — [Garage S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)) support it, but MinIO is _reported_ (a GitHub docs issue, not primary docs; verify in a spike) not to support that lifecycle action and to purge stale uploads on its own schedule (`stale_uploads_expiry`, ~24h). The portable mechanism is an application sweeper (TD-09) that aborts multipart uploads for drafts past their deadline; storage-level rules are a bonus where supported. **Confirmed by the user (2026-11-05):** `UPLOAD_MAX_BYTES` = 10 GiB (10,737,418,240 bytes), the unit for "10GB" (TD-12 cross-references this); default part size 64 MiB via env; upload resume (`ListParts` + re-issued part URLs) is in scope, traced to `docs/project-plan.md` §4 "Pontos de Atenção"; the abandoned-upload sweeper is a BullMQ job scheduler (TD-09).
**Libraries:** `@aws-sdk/client-s3@^3.1163.0`, `@aws-sdk/s3-request-presigner@^3.1163.0`

### phase-03-videos/TD-03

**Recommendation:** it solves host-vs-container resolution with configuration only. Canonical env keys (Joi + `compose.yaml` + `.env.example` + a `storage.config.ts`, per `phase-01-configuracao-base/TD-03`): `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`. Testability, two layers: (1) unit — the presign service's URL has the `S3_PUBLIC_ENDPOINT` host, `X-Amz-Signature` and expiry; (2) integration inside the container — take the presigned URL, send it with `node:http` `request()` to `minio:9000` while overriding the `host` header to the public host (SigV4 verifies the signed `Host`, so the request validates); use `http.request`, not `fetch`, because undici may drop a custom `Host`. Alternatively the test env may set `S3_PUBLIC_ENDPOINT` equal to `S3_ENDPOINT` so presigned URLs are directly usable; keep one test for the host-override case. Browser PUT additionally needs storage-side CORS with `ETag` exposed: AWS-style bucket CORS exists on AIStor and Garage; for open-source MinIO it is _reported_ to be a global setting (`MINIO_API_CORS_ALLOW_ORIGIN`) — verify in a spike against the chosen engine (TD-13).
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Idempotency at three levels: (1) the guarded `draft → processing` transition makes a repeated `complete` a safe no-op or conflict; (2) deterministic `jobId` per video; (3) the worker's processing step is idempotent — deterministic thumbnail key, metadata overwrite, and a final guarded `processing → ready|error` update, so a redelivered job on an already-`ready` video acks without work. The enqueue gap is closed by the periodic reconciliation sweeper already needed in TD-09 (re-enqueues `processing` videos older than a threshold with no live job). Keeping the trigger in the API also keeps the architecture independent of bucket-notification support when the engine changes.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** it keeps one source of truth for entities and config while honoring the separate-container design, and it makes `ffmpeg` available to both the worker and the DoD test run through a single Dockerfile change. Open sub-question for the user: whether the `video-worker` Compose service starts automatically on `docker compose up` (it is a pipeline consumer, not the API) or stays idle like `nestjs-api` (whose `CMD` is `tail -f /dev/null`, per `nestjs-project/CLAUDE.md`'s "never start the application server unless asked"). The recommendation is autostart with `nest start --entryFile worker --watch` for the worker only, with e2e/integration tests importing `WorkerModule` in-process (TD-12) so tests do not depend on the container. **Confirmed by the user (2026-11-05):** the `video-worker` Compose service starts automatically on `docker compose up` (`nest start --entryFile worker --watch`); integration/e2e tests import `WorkerModule` in-process.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** no deprecated dependency, no large scratch disk, and the worker already reaches storage over the Compose network. B stays as an automatic fallback candidate only if the spike shows a class of inputs that fail over HTTP. Metadata persistence (proposal, to be confirmed with the user at resolve time): normalized columns for what the API/UI will query (duration, width, height, video codec, container format, bitrate) plus a trimmed `metadata` JSONB with the rest of the ffprobe output. **Confirmed by the user (2026-11-05):** metadata is persisted as normalized columns (duration, width, height, video codec, container format, bitrate) plus a trimmed `metadata` JSONB; a file ffprobe cannot read is a non-retryable error (TD-09, TD-15).
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** satisfies "curta e única" without adding a dependency whose current major conflicts with the project's Node and test toolchain; uniqueness is guaranteed by the database constraint, not by entropy alone. Alphabet is alphanumeric (no `-`/`_`) to be safe in URLs and copy/paste.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** it keeps the data path out of the API and BFF, and the presigned GET gives correct Range and `Content-Disposition` semantics for free. Mitigations: a stable API URL that redirects on every request (so URL expiry is not a client concern), `ResponseContentType` forced from the stored content type. Note: this assumes the original file is directly playable by browsers; transcoding is out of scope (see header). Open questions for the user: (1) accept that `206` comes from storage rather than the API; (2) before Phase 04 defines visibility, may anonymous users stream/download any `ready` video? Proposed: yes for `ready` (matches the project overview "Usuários anônimos podem assistir livremente"), not-ready videos answer 404, and Phase 04 layers publication/visibility on top — flagged because it exposes never-published videos by public id until then. **Confirmed by the user (2026-11-05):** the `206` is emitted by object storage and asserted in tests against the presigned URL; anonymous users may stream/download any `ready` video and a not-ready video answers 404, with Phase 04 layering visibility on top.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Single `status` enum for this phase's scope, with the naming risk stated to the user (B is the clean alternative if Phase 04 will reuse "draft/published" as publication states). Failure policy: BullMQ `attempts: 3`, exponential backoff (e.g. 30s seed, jitter) for transient errors (storage unreachable, ffmpeg timeout); non-retryable errors (corrupt/unsupported file, no video stream) throw BullMQ's `UnrecoverableError` immediately; when attempts are exhausted the worker's final-failure handler sets `error` with a reason; no automatic re-enqueue from `error` (manual retry is out of scope). Abandoned uploads: a periodic sweeper (BullMQ job scheduler, or `@nestjs/schedule` — decide at implementation) finds `draft` rows past `upload_expires_at`, calls `AbortMultipartUpload`, and deletes the empty draft row (nothing playable exists; Phase 04's draft management applies to uploaded videos only); the same sweeper re-enqueues `processing` rows older than a threshold with no live job (TD-04). **Confirmed by the user (2026-11-05):** the sweeper and the `processing` reconciliation run as a BullMQ job scheduler (not `@nestjs/schedule`); "rascunho" here means the pipeline `draft` status only, Phase 04 adds its own publication/visibility columns.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Provisioning: a one-shot Compose init service (the engine's `mc` client, e.g. `pgsty/mc` if TD-13 picks Silo) that runs `mb --ignore-existing` and applies CORS/lifecycle where supported, with `nestjs-api` and `video-worker` depending on it (`service_completed_successfully`) — preferable to API-on-boot creation, which needs bucket-create permission at runtime and races between API and worker. Tests call an idempotent `CreateBucket` for a dedicated test bucket in setup (TD-12). Health checks: the object-storage probe depends on the chosen image (MinIO exposes `/minio/health/live` and `/minio/health/ready`; whether `curl` or `mc` exists in the image must be checked at implementation) and `redis-cli ping` for Redis if TD-01 = A. Publish storage `9000`/`9001`; never publish Redis.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** it respects the inherited layering, needs no auth changes, and returns 404 uniformly for "not yours". Public surface: only the stream and download endpoints (TD-08, pending its open question); upload initiate/part-urls/complete/abort and the owner's status endpoint stay behind the global guard. Only users with a confirmed account can log in (Phase 02), so no extra confirmation check is added.
**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** Real Compose services and generated fixtures, with Option C only for `*.spec.ts` unit tests of services. Pending question for the user: whether "10GB" means 10 GiB (10,737,418,240 bytes) or 10 GB (10,000,000,000 bytes) for `UPLOAD_MAX_BYTES`; the recommendation is 10 GiB (the larger, safer reading; the part planner works in both). **Confirmed by the user (2026-11-05):** `UPLOAD_MAX_BYTES` = 10 GiB (10,737,418,240 bytes) — see TD-02.
**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** `pgsty/silo` with `pgsty/mc` for the Compose dev/test stack, keeping all code engine-agnostic (AWS SDK + `S3_*` env, no MinIO-only APIs, no dependency on bucket notifications) so Garage or real S3 is a configuration swap; Option B (Garage) is the better pick if the user prioritizes a maintained project over Compose simplicity. The user should confirm the engine knowing upstream MinIO is archived; the architecture docs ("S3 or MinIO") then need a note when this TD is decided. **Confirmed by the user (2026-11-05):** `pgsty/silo` with `pgsty/mc`; application code uses only the S3 API, and the "S3 or MinIO" wording in the project docs is satisfied by this S3-compatible MinIO fork.
**Libraries:** —

### phase-03-videos/TD-14

**Recommendation:** Fraction-of-duration frame, JPEG output (universal browser support; WebP is a later optimization), max width 1280 px with aspect ratio preserved (even height), quality around `-q:v 3`, timeout-bounded, saved with `Content-Type: image/jpeg`. Open sub-question for the user: if the thumbnail step fails after metadata extraction succeeded, should the video still become `ready`? The safe default proposed here is to treat it as a processing failure (`error`), so `ready` always implies a thumbnail. **Confirmed by the user (2026-11-05):** if the thumbnail step fails after metadata extraction the video becomes `error`, so `ready` implies duration and thumbnail present.
**Libraries:** —

### phase-03-videos/TD-15

**Recommendation:** it avoids inventing a format list that the project plan does not define while still failing fast on clearly non-video content types; ffprobe (TD-06) is the authoritative check and its failure maps to the already-decided non-retryable `error` path (TD-09). Option A is the stricter alternative if the product later defines a supported-format list (configurable via env, so no code change). The accepted content type is stored as object metadata (TD-10) and returned with `ResponseContentType` on streaming (TD-08).
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### next-frontend-config-base/TD-01

**Recommendation:** **Option A (Zod 4)**. Three converging reasons: (1) **Type-inference matches the FE's strict-TS culture** — `lib/env.ts` exports a typed `env` object with no `as` casts, satisfying the project's "Type Safety" working principle. (2) **Ecosystem gravity in Next.js / React 19** — Zod is the de-facto schema language for App Router (Server Actions inputs, form resolvers, future contract validation), so introducing it once at the env layer compounds value for forms in Phase 02+. (3) **Direct enablement of TD-02 Option A (`@t3-oss/env-nextjs`)** — t3-env's first-citizen validator. Backend parity with Joi is not load-bearing: env schemas are not shared FE↔BE (different runtimes, different key sets); two validators across two subprojects is a bounded cost.

**Libraries:** zod

### next-frontend-config-base/TD-02

**Recommendation:** **Option A (`@t3-oss/env-nextjs`)**. The only option that combines (i) **type-level NEXT_PUBLIC_ prefix enforcement**, (ii) **runtime Proxy-based leak detection**, and (iii) **single-file, single-import-path consumer ergonomics**. Option B reaches roughly the same _structural_ outcome at higher implementation and maintenance cost, with a weaker guarantee (no prefix enforcement, no proxy). Option C is unsafe at any non-trivial team size. The marginal cost over B is one ~3KB dep — well-spent for the strongest boundary among the three.

**Libraries:** @t3-oss/env-nextjs

### next-frontend-config-base/TD-03

**Recommendation:** **Option A (Strict BFF — single server-only `API_URL`)**. Aligned with the BFF testing strategy and architectural commitment already documented in `next-frontend/CLAUDE.md` (Route Handlers as the only NestJS caller; BFF tests stub `fetch` via MSW). Eliminates CORS, eliminates public exposure of the backend URL, and produces the smallest correct foundation. Option B's `NEXT_PUBLIC_API_URL` is a future-proofing concession with no current consumer — and adding a public key later is a non-breaking change, while removing one is breaking. Option C ties a foundational decision to infra work explicitly deferred elsewhere. The Docker networking gap (how server-in-container resolves the backend) is a separate orthogonal decision, surfaced below.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** @nestjs/swagger

**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` §3 Feature Implementation Checklist)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

### next-frontend

_Out of scope for this phase — no frontend work (see Scope → Deferred subprojects)._
