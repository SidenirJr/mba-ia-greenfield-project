---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-05
scope_description: "Backend foundation for video upload and processing: object storage engine and layout, job queue, 10GB direct-to-storage multipart upload with presigned URLs, processing trigger and worker, ffprobe/ffmpeg extraction, unique public video URL, streaming/download, status lifecycle, authorization, accepted upload formats, and integration-test strategy."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers everything in this phase: `src/videos/` module, storage and queue integration, the worker entrypoint, migration for the videos table, and the Compose services (object storage, queue, worker) declared in `nestjs-project/compose.yaml`.
- `next-frontend/` — the video UI is out of scope for this phase (no upload/player screens). TD-02, TD-03 and TD-08 are marked `Cross-layer` because they define the HTTP/storage contract a future frontend will consume (inherited constraint: `next-frontend-config-base/TD-03` = strict BFF, and its Cons already state that video payloads must use presigned object-storage URLs, not the backend URL). No frontend implementation decision is open in this document.

**Inherited constraints (not reopened):** Compose service names as hosts (root `CLAUDE.md`, Docker Networking); NestJS 11.1.16 / Node 25.6.0 image (`Dockerfile.dev`) / Jest 30 + ts-jest under CommonJS (`nodenext` with no `"type": "module"`); namespaced `registerAs` config + Joi env validation (`phase-01-configuracao-base/TD-01..TD-03`, which already anticipates a `storage.config.ts`); global `JwtAuthGuard` with `@Public()` opt-out and `JwtPayload { sub, email }` (`phase-02-auth`); channels 1:1 with users via unique `channels.user_id`; `DomainException` + filters for errors; OpenAPI decorators on every controller; integration tests against real Compose services, run in-band inside `nestjs-api`. Host ports 80, 6379, 6380, 3306, 3307, 8081-8084 and 8888 are occupied by other containers on the developer machine: **no Redis/queue port may be published**; MinIO 9000/9001 may be.

**Phase 03 capability bullets (literal, from `docs/project-plan.md`):**

- C1 — "Serviço de armazenamento de arquivos (vídeos e thumbnails)"
- C2 — "Serviço de processamento em segundo plano (filas)"
- C3 — "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"
- C4 — "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"
- C5 — "Processamento automático do vídeo após upload (extração de duração e metadados)"
- C6 — "Geração automática de thumbnail a partir de um frame do vídeo"
- C7 — "URL única por vídeo, sem conflito com outros vídeos"
- C8 — "Reprodução via streaming (sem necessidade de download completo)"
- C9 — "Download do vídeo pelo usuário"

**Out of scope (not Phase 03 bullets; recorded, not requirements):** video visibility public/unlisted, draft → publication flow, title/description/category/custom thumbnail editing (Phase 04); player UI, view counts, download button (Phase 05); transcoding / HLS / adaptive bitrate (not in any phase bullet — playback in Phase 03 serves the original file); frontend upload UI.

---

## TD-01: Job Queue Technology

**Scope:** Backend

**Capability:** "Serviço de processamento em segundo plano (filas)"

**Context:** `docs/diagrams/software-arch.mermaid` leaves the queue as "TBD". The queue carries "process video" jobs from the API to the worker (TD-05), must support retries with backoff and a terminal failure state (TD-09), and must be exercised against a real instance in integration tests inside the `nestjs-api` container (TD-12). Compose services are reached by service name; host port 6379 is taken, so a Redis-backed option must stay unpublished. Versions checked with `npm view` on 2026-11-05: `bullmq` 6.7.0, `@nestjs/bullmq` 12.0.0, `pg-boss` 12.38.1, `@nestjs/microservices` 12.3.3 (11.2.8 on the Nest 11 line), `amqplib` 2.2.1. An SQS-compatible emulator (ElasticMQ/LocalStack) was considered and not carried forward: no official Nest module, AWS-specific redrive semantics, and an extra emulator container with no gain over the options below (not benchmarked).

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- `@nestjs/bullmq` 12.0.0 and `@nestjs/bull-shared` 12 declare peers `@nestjs/core ^10 || ^11 || ^12`, so they install on Nest 11.1.16; `bullmq` 6 ships a CJS build (`main: ./dist/cjs`) so Jest/ts-jest are unaffected; `ioredis` is an optional peer to install explicitly. Retries and backoff are job options (`attempts`, `backoff: { type: 'exponential', delay, jitter }` — [BullMQ retrying docs](https://docs.bullmq.io/guide/retrying-failing-jobs)); a custom `jobId` deduplicates; `@Processor` + `WorkerHost` runs in any Nest context. A new `redis` Compose service, unpublished, reached as `redis:6379`.
- **Pros:** Official, best-documented Nest integration; retry/backoff/dedup are built in; mature Redis backend; test isolation via queue `prefix`/`obliterate`.
- **Cons:** A new stateful container; the [production guide](https://docs.bullmq.io/guide/going-to-production) requires `maxmemory-policy noeviction` and recommends persistence (AOF), which must be set in the Compose command; no native dead-letter queue (terminal failures live in the `failed` set until removed).

### Option B: BullMQ 6 with its built-in PostgreSQL backend (no Redis)
- Same BullMQ API, selected with `createPostgresBackend` as the third constructor argument or `setDefaultBackendFactory(createPostgresBackend)`; needs only `pg` (already installed, `^8.20`) and PostgreSQL 13+ ([announcement](https://bullmq.io/news/260927/bullmq-v6-postgresql/)). BullMQ 6.0.0 was published 2026-07-30, so the backend is about three months old; the announcement reports the 800+ shared tests pass against it and roughly half of Redis's peak throughput (irrelevant at video-job volumes).
- **Pros:** No extra container, nothing to publish or persist separately; same code path as A, so switching later is mostly the registration line; consistent with the Phase 02 preference for "PostgreSQL already in the stack".
- **Cons:** **Nest integration unverified — needs a spike**: the `@nestjs/bullmq` factory builds `new Queue(name, options)` with no backend argument per its docs, so only the global `setDefaultBackendFactory` hook (called before bootstrap) is a candidate; schema lives in a separate `bullmq` schema and since 6.1 is not migrated on connect (`migrate: true` or `runMigrations()` — a second migration path next to TypeORM's); dashboard metrics package is Redis-only; youngest option here.

### Option C: pg-boss (PostgreSQL-backed)
- `pg-boss` 12.38.1 (engines `>=22.12`, fine on Node 25.6) stores jobs in the existing Postgres. Native `retryLimit`, `retryDelay`, `retryBackoff`, `deadLetter` queue, `singletonKey`/queue policies ([docs](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md)); handlers receive job batches.
- **Pros:** Native dead-letter queue and dedup policies; zero new infrastructure; strongest "Postgres-only" story.
- **Cons:** **ESM-only** (`"type": "module"` in its manifest) while this project is CommonJS under Jest 30 + ts-jest; ESM-only dependencies are a known source of `Must use import to load ES Module` / `Cannot use import statement` failures under Jest (e.g. nanoid ≥ 4), so a spike is mandatory; no official Nest module (hand-written provider and lifecycle); a different mental model from the `@Processor` convention.

### Option D: RabbitMQ (`@nestjs/microservices` RMQ transport)
- `@nestjs/microservices` must stay on 11.x (12.x peers `@nestjs/core ^12`) plus `amqplib` 2.2.1. Dead lettering is native via `x-dead-letter-exchange` queue arguments; delayed retry is not a job option — it is built with TTL retry queues or a delayed-message plugin, and `ack`/`nack` is handled manually. A new `rabbitmq` container (AMQP 5672, not in the occupied list).
- **Pros:** Real broker semantics, native DLX, no Redis; protocol-level decoupling if more consumers appear.
- **Cons:** Most infrastructure and code for this need (retry topology, idempotency/dedup by hand — no job ids); backoff must be hand-built; heavier test setup; the Nest transport is message-oriented rather than job-oriented.

**Recommendation:** **Option A (BullMQ + Redis)** — it is the only option that combines the official Nest integration, built-in retry/backoff/`jobId` dedup, a CJS-safe package, and no unverified glue; the unpublished Redis service avoids the 6379 conflict. Option B is the strongest alternative if the user wants to avoid a Redis container (it fits the Phase 02 "Postgres suffices" stance), but it is ~3 months old and its Nest hook is unverified; because the BullMQ API is identical, A → B later is a small change confined to queue registration. The missing native DLQ is acceptable: the terminal `error` status plus failure reason in the video row (TD-09) is the dead-letter record. Canonical env keys if A is chosen: `REDIS_HOST=redis`, `REDIS_PORT=6379` in Joi schema, `compose.yaml` and `.env.example`.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`) — Redis runs as an unpublished Compose service reached as `redis:6379` (`REDIS_HOST=redis`, `REDIS_PORT=6379`).

**Libraries:** `bullmq@^6.7.0`, `@nestjs/bullmq@^12.0.0`, `ioredis@^5.11.1`

---

## TD-02: Upload Strategy for Files up to 10GB

**Scope:** Cross-layer

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" (also "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" — the draft row is created at initiate; and `docs/project-plan.md` §4 "Pontos de Atenção": the upload must "permita retomar em caso de falha de conexão")

**Context:** A single S3 `PutObject` accepts at most 5 GB ([AWS: Uploading objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html)), so a 10GB file cannot be one presigned PUT: multipart is mandatory for the direct-to-storage path. S3 multipart limits ([AWS: multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)): 1–10,000 parts, part size 5 MiB–5 GiB (last part exempt), max object far above 10GB. The C4 diagram has the frontend talking to storage and the API only publishing jobs; with the inherited strict-BFF (`next-frontend-config-base/TD-03`) a byte-proxying API would add storage ← API ← BFF ← browser hops. The 10GB limit itself needs a unit: GiB vs GB was resolved by the user: 10 GiB (see Decision below).

**Options:**

### Option A: S3 multipart with per-part presigned URLs (API issues URLs and finalizes only)
- `POST` initiate: API validates owner/size/type, creates the draft row, calls `CreateMultipartUpload`, stores `upload_id`, returns `part_size` + part count. `POST` part-URLs: returns presigned `UploadPart` URLs for the requested part numbers (re-requestable, which gives resume together with `ListParts`). Browser PUTs parts directly to storage and keeps each `ETag`. `POST` complete (TD-04): API sends `CompleteMultipartUpload` with the ETag list. `DELETE`/abort: `AbortMultipartUpload`. The API never carries file bytes.
- **Pros:** Zero upload bytes through the API (satisfies "sem impacto na performance"); parts retry independently and in parallel; resume = `ListParts` + re-issue URLs; matches the C4 diagram and the BFF constraint; `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 3.1163.0 are the standard, maintained tools.
- **Cons:** The client must implement part slicing, ETag collection and complete (future frontend work); the browser needs CORS on the storage endpoint with `ETag` exposed (support differs per engine — TD-03/TD-13); more endpoints than a single upload.

### Option B: Stream the file through the API (multer/busboy → `@aws-sdk/lib-storage` `Upload`)
- Client posts the whole file to the API, which pipes it to storage as a multipart upload.
- **Pros:** Single request for the client; no CORS or presign host issues; server controls the whole flow.
- **Cons:** 10GB crosses Node and the BFF (two proxies with their own body/time limits), ties up API sockets for hours, contradicts the capability's "sem impacto na performance" and the C4 diagram; no cheap resume; backpressure and disconnect handling become our code.

### Option C: tus resumable protocol (`@tus/server` 2.4.7 with an S3 store)
- tus provides standardized resumable uploads (HEAD offset, PATCH chunks); the server persists to S3 using multipart internally.
- **Pros:** Standard resumable protocol with ready client libraries; resume is a protocol feature.
- **Cons:** Data still flows through a tus endpoint hosted by our process (or another service to deploy), the same bandwidth/BFF problem as B; `@tus/server` 2.x is built on Web `Request`/`Response` (srvx), adding glue to Nest 11's Express adapter; adds a protocol the project does not otherwise use.

**Recommendation:** **Option A** — it is the only option where the API does not touch the bytes, it satisfies resume from §4 through `ListParts`, and it matches the architecture diagram and inherited BFF decision. Proposed parameters (all env-configurable): server-chosen part size, default 64 MiB and never below 5 MiB or `ceil(size / 10000)` (10 GiB ⇒ 160 parts, far from the 10,000 cap); declared size validated against `UPLOAD_MAX_BYTES`; the API returns `part_size` and the client must use it. Abandoned uploads: do **not** rely on storage lifecycle alone — S3 and Garage (documented: `AbortIncompleteMultipartUpload` supported — [Garage S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)) support it, but MinIO is _reported_ (a GitHub docs issue, not primary docs; verify in a spike) not to support that lifecycle action and to purge stale uploads on its own schedule (`stale_uploads_expiry`, ~24h). The portable mechanism is an application sweeper (TD-09) that aborts multipart uploads for drafts past their deadline; storage-level rules are a bonus where supported. **Confirmed by the user (2026-11-05):** `UPLOAD_MAX_BYTES` = 10 GiB (10,737,418,240 bytes), the unit for "10GB" (TD-12 cross-references this); default part size 64 MiB via env; upload resume (`ListParts` + re-issued part URLs) is in scope, traced to `docs/project-plan.md` §4 "Pontos de Atenção"; the abandoned-upload sweeper is a BullMQ job scheduler (TD-09).

**Decision:** A (S3 multipart with per-part presigned URLs). Parameters confirmed by the user: **`UPLOAD_MAX_BYTES` = 10 GiB = 10,737,418,240 bytes** (resolves AMB-1; TD-12 inherits it); default part size 64 MiB, env-configurable, never below 5 MiB or `ceil(size / 10000)`; **upload resume via `ListParts` + re-issued part URLs is in scope** (resolves AMB-2; origin `docs/project-plan.md` §4 "Pontos de Atenção": "permita retomar em caso de falha de conexão"); abandoned multipart uploads are aborted by the application sweeper (TD-09).

**Libraries:** `@aws-sdk/client-s3@^3.1163.0`, `@aws-sdk/s3-request-presigner@^3.1163.0`

---

## TD-03: Presigned URL Host and Endpoint Configuration

**Scope:** Cross-layer

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** AWS SigV4 signs the `Host` header, so a presigned URL is only valid for the host it was signed with. The API container reaches storage as `minio:9000` (Docker rule), but a browser on the host cannot resolve `minio`; it needs a host-reachable origin such as `localhost:9000` (published port). Tests run inside the `nestjs-api` container where `localhost:9000` is not storage. Two audiences, two hosts. Also relevant: AWS SDK v3 defaults `requestChecksumCalculation` to `WHEN_SUPPORTED`, which adds CRC32 checksum headers that S3-compatible servers and presigned browser PUTs may not expect (`WHEN_REQUIRED` removes them — [SDK docs](https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/CLIENTS.md)). Depends on TD-13 (engine) and TD-10 (bucket).

**Options:**

### Option A: Two endpoints, two S3 clients (`S3_ENDPOINT` internal, `S3_PUBLIC_ENDPOINT` for presigning)
- A normal client uses `S3_ENDPOINT=http://minio:9000` (HeadObject, Complete, Abort, worker I/O). A second presign-only client is built with `S3_PUBLIC_ENDPOINT=http://localhost:9000` (+ `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'`). Presigning is a local computation (no network call), so the API need not reach the public host. In production both can point to the same real endpoint.
- **Pros:** No host-file hacks or extra infra; explicit and env-driven; the worker presigns with the **internal** endpoint for ffprobe over HTTP (TD-06), so its URLs never leave the Compose network; testable (below).
- **Cons:** Two clients/config keys to keep consistent; a misconfigured public endpoint yields signature errors that look like storage bugs.

### Option B: One endpoint with a hostname that works everywhere
- Make `minio` resolvable on the developer host (`/etc/hosts`) or publish storage under a shared name, and use `S3_ENDPOINT=http://minio:9000` for everything.
- **Pros:** One client, one key.
- **Cons:** Requires per-developer host configuration outside the repo; breaks on CI and on other machines; contradicts "works from a clean `docker compose up`".

### Option C: Reverse proxy that rewrites to a stable public host
- A proxy (nginx/Traefik) in Compose fronts storage; clients and API sign for the proxy host and the proxy forwards preserving `Host`.
- **Pros:** Closest to a production CDN/ingress topology.
- **Cons:** New infrastructure and its own streaming/Range configuration for ≤10GB bodies; hardest to debug signature mismatches; unjustified for this phase.

**Recommendation:** **Option A** — it solves host-vs-container resolution with configuration only. Canonical env keys (Joi + `compose.yaml` + `.env.example` + a `storage.config.ts`, per `phase-01-configuracao-base/TD-03`): `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`. Testability, two layers: (1) unit — the presign service's URL has the `S3_PUBLIC_ENDPOINT` host, `X-Amz-Signature` and expiry; (2) integration inside the container — take the presigned URL, send it with `node:http` `request()` to `minio:9000` while overriding the `host` header to the public host (SigV4 verifies the signed `Host`, so the request validates); use `http.request`, not `fetch`, because undici may drop a custom `Host`. Alternatively the test env may set `S3_PUBLIC_ENDPOINT` equal to `S3_ENDPOINT` so presigned URLs are directly usable; keep one test for the host-override case. Browser PUT additionally needs storage-side CORS with `ETag` exposed: AWS-style bucket CORS exists on AIStor and Garage; for open-source MinIO it is _reported_ to be a global setting (`MINIO_API_CORS_ALLOW_ORIGIN`) — verify in a spike against the chosen engine (TD-13).

**Decision:** A (`S3_ENDPOINT` internal + `S3_PUBLIC_ENDPOINT` for presigning; separate presign client with `forcePathStyle: true` and `requestChecksumCalculation: 'WHEN_REQUIRED'`).

**Libraries:** —

---

## TD-04: Processing Trigger and Job Idempotency

**Scope:** Backend

**Capability:** "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** Something must turn "upload finished" into a queued job. Because the API performs `CompleteMultipartUpload` itself (TD-02), it is already in the loop at the exact moment the object becomes whole. At-least-once delivery means the job (and the trigger) must be idempotent. Depends on TD-01, TD-02, TD-09.

**Options:**

### Option A: The `complete` endpoint finalizes the upload and enqueues the job
- `POST …/complete` → API checks ownership and `draft` status, completes the multipart upload, verifies the object (`HeadObject` size equals declared size), transitions `draft → processing` with a guarded `UPDATE … WHERE status = 'draft'`, then enqueues with a deterministic `jobId` derived from the video id (BullMQ ignores a second add with the same id while it exists).
- **Pros:** Single explicit trigger under our control, engine-independent, trivially testable; the client gets a synchronous accepted/rejected answer; no extra configuration.
- **Cons:** DB transition and enqueue are not atomic (a crash between them leaves a `processing` video with no job) — mitigated by the reconciliation sweeper (below); depends on the client calling `complete`.

### Option B: Storage bucket notifications to the queue
- Configure the bucket to emit `ObjectCreated` events (MinIO community supports AMQP, MQTT, PostgreSQL, Redis and webhook targets — [MinIO docs](https://docs.min.io/community/minio-object-store/administration/monitoring/bucket-notifications.html)); a consumer turns events into jobs.
- **Pros:** Decouples the client from the trigger; also catches uploads completed outside the API.
- **Cons:** Engine-specific (Garage and SeaweedFS document bucket notifications as not supported), which narrows TD-13; MinIO's Redis target does not publish BullMQ job format, so a webhook/bridge consumer is needed; the multipart-complete event name and delivery guarantees must be verified; asynchronous and harder to assert in tests.

### Option C: `complete` endpoint + transactional outbox
- As A, but the enqueue intent is written to an outbox table in the same transaction as the status change; a relay publishes it.
- **Pros:** Removes the dual-write gap by construction.
- **Cons:** New table and relay process for a low-volume pipeline; the reconciliation sweeper achieves the same recovery at much lower cost.

**Recommendation:** **Option A**, with idempotency at three levels: (1) the guarded `draft → processing` transition makes a repeated `complete` a safe no-op or conflict; (2) deterministic `jobId` per video; (3) the worker's processing step is idempotent — deterministic thumbnail key, metadata overwrite, and a final guarded `processing → ready|error` update, so a redelivered job on an already-`ready` video acks without work. The enqueue gap is closed by the periodic reconciliation sweeper already needed in TD-09 (re-enqueues `processing` videos older than a threshold with no live job). Keeping the trigger in the API also keeps the architecture independent of bucket-notification support when the engine changes.

**Decision:** A (`complete` endpoint finalizes the upload and enqueues the job; reconciliation sweeper closes the enqueue gap).

**Libraries:** —

---

## TD-05: Worker Location and Runtime

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The C4 diagram has a separate "Video Worker (FFmpeg)" container consuming the queue, reading/saving storage and updating the DB. FFmpeg needs a binary in the image. The root DoD runs `npm test` inside `nestjs-api`; integration tests that call `ffprobe`/`ffmpeg` (TD-12) require the binaries there too. Root `CLAUDE.md` Single Responsibility: the worker must not take ownership of another module's entity. Depends on TD-01.

**Options:**

### Option A: Same codebase, separate entrypoint and Compose service
- A `WorkerModule` with its own `src/worker.ts` bootstrapped via `NestFactory.createApplicationContext` (no HTTP listener), reusing `StorageModule`, `VideosModule` and TypeORM entities; a `video-worker` Compose service built from the same `Dockerfile.dev` and mounting the same volume. The worker calls `VideosService` transition methods instead of touching the repository, so `Video` stays owned by `VideosModule`. `ffmpeg` is added to `Dockerfile.dev` (apt), which serves both `nestjs-api` (tests) and the worker; image size impact not measured.
- **Pros:** One dependency tree, config and entity set (no drift); separate process and container as in the C4 diagram, so CPU-heavy ffmpeg cannot starve the API; trivially testable by importing `WorkerModule` in a test.
- **Cons:** Worker and API ship together (acceptable at this scale); `nestjs-api` image carries ffmpeg it does not use at runtime in production unless the production image is split later (out of scope: production deploy is Phase 07).

### Option B: Separate package/folder with its own `package.json` (e.g. `video-worker/`)
- Independent Node project with its own image; shares nothing by default.
- **Pros:** Hard isolation; can scale/deploy independently; smaller worker deps.
- **Cons:** Duplicated entities/config/migrations or a new shared package (monorepo tooling the project does not have); two sets of lint/tsc/test commands; DB schema drift risk; violates the "single module owns the entity" rule unless a shared library is introduced.

### Option C: Worker as a processor inside the API process
- Register the BullMQ `@Processor` in `AppModule`; ffmpeg runs as child processes of the API container.
- **Pros:** Least moving parts; no extra service.
- **Cons:** Heavy ffmpeg/IO competes with request handling in one container and cgroup; contradicts the C4 "Video Worker" container and the "sem impacto na performance" intent; scales API and worker together.

**Recommendation:** **Option A** — it keeps one source of truth for entities and config while honoring the separate-container design, and it makes `ffmpeg` available to both the worker and the DoD test run through a single Dockerfile change. Open sub-question for the user: whether the `video-worker` Compose service starts automatically on `docker compose up` (it is a pipeline consumer, not the API) or stays idle like `nestjs-api` (whose `CMD` is `tail -f /dev/null`, per `nestjs-project/CLAUDE.md`'s "never start the application server unless asked"). The recommendation is autostart with `nest start --entryFile worker --watch` for the worker only, with e2e/integration tests importing `WorkerModule` in-process (TD-12) so tests do not depend on the container. **Confirmed by the user (2026-11-05):** the `video-worker` Compose service starts automatically on `docker compose up` (`nest start --entryFile worker --watch`); integration/e2e tests import `WorkerModule` in-process.

**Decision:** A (same codebase, `src/worker.ts` entrypoint, own Compose service) — the `video-worker` service autostarts on `docker compose up`; integration/e2e tests import `WorkerModule` in-process.

**Libraries:** —

---

## TD-06: Metadata Extraction and FFmpeg Invocation

**Scope:** Backend

**Capability:** "Processamento automático do vídeo após upload (extração de duração e metadados)" (thumbnail parameters continue in TD-14)

**Context:** For files up to 10GB the worker must obtain duration and metadata without copying the whole file when avoidable. Two axes are decided together: how to call ffprobe/ffmpeg (library vs direct process) and how the worker reads the file (disk vs HTTP vs pipe). `fluent-ffmpeg` 2.1.3 (last modified 2025-05-22) is marked deprecated on npm (`Package no longer supported`), checked with `npm view fluent-ffmpeg deprecated`. TD-14 continues this decision for the thumbnail frame and format.

**Options:**

### Option A: Direct `child_process` (`execFile`/`spawn`) on ffprobe/ffmpeg, reading via an internal presigned HTTP URL
- `ffprobe -v error -print_format json -show_format -show_streams <url>` and ffmpeg both open an `http://minio:9000/...` presigned URL (generated with the worker's **internal** endpoint, TD-03); ffmpeg's HTTP protocol uses Range requests, so only the needed bytes (container header, and the tail for non-faststart MP4) are fetched. JSON output is parsed and validated in a small typed mapper; a timeout and non-zero exit become typed failures (retryable vs non-retryable, TD-09).
- **Pros:** No deprecated dependency; no 10GB temp disk per concurrent job; fastest for large files; fewest lines of glue.
- **Cons:** Behavior with non-faststart files and slow Range paths must be proven in a spike (generate a non-faststart MP4 with ffmpeg `lavfi` and assert extraction); we own argument building and stderr parsing.

### Option B: Direct `child_process`, but download the original to a temp file first
- Stream the object to `os.tmpdir()`, run ffprobe/ffmpeg on the local path, delete in `finally`.
- **Pros:** Most predictable for every container/codec (local seekable file); simplest to reason about.
- **Cons:** Needs up to 10GB scratch space per concurrent job and minutes of copy before any work; temp-file cleanup on crash; disk becomes the worker's scaling limit.

### Option C: `fluent-ffmpeg` wrapper (download or URL input)
- Fluent API over the same binaries.
- **Pros:** Familiar API, many examples.
- **Cons:** Deprecated on npm and unmaintained since 2025; adds a dependency for what is two command lines; its types are community-maintained.

**Recommendation:** **Option A** — no deprecated dependency, no large scratch disk, and the worker already reaches storage over the Compose network. B stays as an automatic fallback candidate only if the spike shows a class of inputs that fail over HTTP. Metadata persistence (proposal, to be confirmed with the user at resolve time): normalized columns for what the API/UI will query (duration, width, height, video codec, container format, bitrate) plus a trimmed `metadata` JSONB with the rest of the ffprobe output. **Confirmed by the user (2026-11-05):** metadata is persisted as normalized columns (duration, width, height, video codec, container format, bitrate) plus a trimmed `metadata` JSONB; a file ffprobe cannot read is a non-retryable error (TD-09, TD-15).

**Decision:** A (direct `child_process` spawn of ffprobe/ffmpeg reading an internal presigned URL). Metadata persistence confirmed by the user: normalized columns (duration, width, height, video codec, container format, bitrate) plus a trimmed `metadata` JSONB with the rest of the ffprobe output.

**Libraries:** —

---

## TD-07: Public Video Identifier (Unique URL)

**Scope:** Backend

**Capability:** "URL única por vídeo, sem conflito com outros vídeos" (and `docs/project-plan.md` §4: "uma URL curta e única que nunca conflite")

**Context:** Each video needs a short public identifier distinct from the internal key. `users`/`channels` use `uuid` primary keys; the channel nickname flow (`channels.service.ts`) already establishes the pattern "pre-check, save, catch Postgres unique violation `23505`, retry with a new value, `MAX_RETRIES = 5`". Candidate libs checked with `npm view`: `nanoid` 6.0.2 is ESM-only (`type: module`) and its engines are `^22 || ^24 || >=26`, which excludes the project's Node 25.6.0 image; `ulid` 3.0.2 produces 26-character IDs.

**Options:**

### Option A: Random 11-character base62 id from `node:crypto` (`randomInt`), unique constraint + retry
- Generated in-process with `crypto.randomInt(62)` per character (uniform, no modulo bias); ~65 bits of entropy; unique index on the column; on `23505` regenerate and retry (same pattern as nicknames). Internal `uuid` PK stays the foreign-key and storage-key identifier (TD-10).
- **Pros:** Zero dependency; no ESM/Jest or engines risk; short YouTube-like URLs; birthday collision at 10⁹ videos is roughly 0.7% and is absorbed by the retry.
- **Cons:** Not time-sortable; we own ~10 lines of code and its test.

### Option B: `nanoid` (custom alphabet, 11 chars)
- Same shape via the `customAlphabet` API.
- **Pros:** Well-known; fewer lines.
- **Cons:** v6 is ESM-only and excludes Node 25 in `engines` (the project image), and ESM-only packages are a known Jest-under-CJS failure source; pinning `nanoid@3` (CJS) works but ties the project to an old major.

### Option C: UUID (v4/v7) or ULID as the public id
- Reuse `uuid`, or `ulid` 3.0.2 (26 chars, time-ordered).
- **Pros:** No code; collision-free in practice; ULID/UUIDv7 sort by time.
- **Cons:** 26–36 characters — not "curta"; time-ordering leaks creation time in the URL.

**Recommendation:** **Option A** — satisfies "curta e única" without adding a dependency whose current major conflicts with the project's Node and test toolchain; uniqueness is guaranteed by the database constraint, not by entropy alone. Alphabet is alphanumeric (no `-`/`_`) to be safe in URLs and copy/paste.

**Decision:** A (11-char base62 id via `crypto.randomInt`, unique constraint + retry on `23505`).

**Libraries:** —

---

## TD-08: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback needs HTTP Range support (`206 Partial Content`, `Accept-Ranges`, `Content-Range`); download needs `Content-Disposition: attachment`. The C4 diagram has the frontend streaming from object storage; the inherited strict-BFF (`next-frontend-config-base/TD-03`) means a proxying API would put storage → API → BFF → browser in the path of multi-GB files. Phase 03's bullets are only "streaming" and "download": who may watch (visibility, unlisted, published-only) is Phase 04/05 and is **not** decided here — recorded as an open question below. Depends on TD-03, TD-09, TD-11.

**Options:**

### Option A: API endpoint authorizes, then redirects (302/307) to a short-lived presigned GET
- Endpoints such as `GET …/stream` and `GET …/download` check the video is `ready`, then redirect to a presigned `GetObject` URL (public endpoint, TD-03). Download sets `ResponseContentDisposition: attachment; filename=…` on the presigned request, so the storage engine emits the header. Range requests go straight to storage, which answers `206`, `Accept-Ranges` and `Content-Range` natively.
- **Pros:** The API never carries video bytes; Range correctness is the storage engine's, not ours; matches C4 and the BFF constraint; one code path for stream and download.
- **Cons:** **The `206` is emitted by storage, not by the API** (the global task text mentions 206/Range; a test must assert it against the presigned URL — decision for the user below); presigned URL expiry vs long playback with repeated Range requests needs a player-side check in Phase 05; the browser needs the public storage origin and CORS for cross-origin media.

### Option B: API proxy with Range passthrough
- The API forwards the `Range` header to `GetObject` and pipes the body with `206`, `Content-Range`, `Accept-Ranges`, `Content-Length`.
- **Pros:** Single stable URL; authorization on every byte request; the API itself emits and tests the 206 behavior.
- **Cons:** Every playback and download byte crosses Node and the BFF; must handle backpressure and client-abort; scales API with viewers; contradicts the C4 and BFF constraint.

### Option C: Public-read prefix on the bucket (no per-request check)
- Mark `videos/*` anonymously readable and hand clients the stable object URL.
- **Pros:** Simplest; cacheable; best CDN story.
- **Cons:** Cannot honor Phase 04's draft/unlisted rules later without migrating URLs; exposes unready or failed objects by key; weakest authorization.

**Recommendation:** **Option A** — it keeps the data path out of the API and BFF, and the presigned GET gives correct Range and `Content-Disposition` semantics for free. Mitigations: a stable API URL that redirects on every request (so URL expiry is not a client concern), `ResponseContentType` forced from the stored content type. Note: this assumes the original file is directly playable by browsers; transcoding is out of scope (see header). Open questions for the user: (1) accept that `206` comes from storage rather than the API; (2) before Phase 04 defines visibility, may anonymous users stream/download any `ready` video? Proposed: yes for `ready` (matches the project overview "Usuários anônimos podem assistir livremente"), not-ready videos answer 404, and Phase 04 layers publication/visibility on top — flagged because it exposes never-published videos by public id until then. **Confirmed by the user (2026-11-05):** the `206` is emitted by object storage and asserted in tests against the presigned URL; anonymous users may stream/download any `ready` video and a not-ready video answers 404, with Phase 04 layering visibility on top.

**Decision:** A (API authorizes, then redirects to a short-lived presigned GET). Confirmed by the user: the `206 Partial Content` is emitted by object storage (not the API) and is asserted against the presigned URL in tests; anonymous users may stream/download any `ready` video; a not-ready video answers 404 (Phase 04 layers visibility on top).

**Libraries:** —

---

## TD-09: Video Status Lifecycle, Failure Handling and Abandoned Uploads

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Serviço de processamento em segundo plano (filas)"

**Context:** The video row records where it is in the pipeline: `rascunho` at initiate, then processing, then ready or error. **Naming collision to resolve:** "rascunho" appears in this phase's bullet (pre-registered at upload start) and again in Phase 04's "Fluxo de rascunho → publicação" (publication axis). This document does not define Phase 04 semantics. Depends on TD-01, TD-02, TD-04.

**Options:**

### Option A: Single `status` enum with pipeline values: `draft` → `processing` → `ready` | `error`
- `draft` means "pre-registered, upload pending/in progress" (also holds `upload_id`, deadline). Transitions only via guarded updates: `draft → processing` (complete), `processing → ready|error` (worker). `error` stores a reason code/message. Phase 04 would add its own columns (e.g. publication/visibility) rather than overload this enum.
- **Pros:** Matches the capability text and the brief; smallest schema; one field to check in streaming (`ready` only).
- **Cons:** Phase 04 may want `draft` to also mean "uploaded but unpublished" — they would then need to rename or split; the enum is a migration if changed.

### Option B: Separate pipeline-status column; leave publication axis entirely to Phase 04
- Column named for the pipeline (`processing_status`: `pending_upload`, `processing`, `ready`, `failed`), no value called "draft" at all; Phase 04 introduces `published_at`/visibility with its own draft/published semantics.
- **Pros:** Removes the collision permanently; each axis evolves independently.
- **Cons:** Deviates from the bullet's wording ("rascunho"); API consumers must read two concepts from Phase 04 on.

### Option C: Fine-grained enum (`draft`, `uploading`, `uploaded`, `processing`, `ready`, `error`)
- Extra states for in-flight upload and post-complete-pre-enqueue.
- **Pros:** Closes the enqueue gap visibly; richer UI later.
- **Cons:** More transitions to guard and test; `uploaded` only exists to patch the non-atomic enqueue the sweeper already covers.

**Recommendation:** **Option A** for this phase's scope, with the naming risk stated to the user (B is the clean alternative if Phase 04 will reuse "draft/published" as publication states). Failure policy: BullMQ `attempts: 3`, exponential backoff (e.g. 30s seed, jitter) for transient errors (storage unreachable, ffmpeg timeout); non-retryable errors (corrupt/unsupported file, no video stream) throw BullMQ's `UnrecoverableError` immediately; when attempts are exhausted the worker's final-failure handler sets `error` with a reason; no automatic re-enqueue from `error` (manual retry is out of scope). Abandoned uploads: a periodic sweeper (BullMQ job scheduler, or `@nestjs/schedule` — decide at implementation) finds `draft` rows past `upload_expires_at`, calls `AbortMultipartUpload`, and deletes the empty draft row (nothing playable exists; Phase 04's draft management applies to uploaded videos only); the same sweeper re-enqueues `processing` rows older than a threshold with no live job (TD-04). **Confirmed by the user (2026-11-05):** the sweeper and the `processing` reconciliation run as a BullMQ job scheduler (not `@nestjs/schedule`); "rascunho" here means the pipeline `draft` status only, Phase 04 adds its own publication/visibility columns.

**Decision:** A (single `status` enum `draft → processing → ready | error`). Confirmed by the user: the abandoned-upload sweeper and reconciliation use a BullMQ job scheduler (not `@nestjs/schedule`); "rascunho" in this phase means pipeline draft only — Phase 04 adds its own publication/visibility columns.

**Libraries:** —

---

## TD-10: Bucket Layout, Object Keys and Provisioning

**Scope:** Backend

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** Videos and thumbnails must be stored and addressable by key; buckets must exist before the API, worker and tests use them; storage and queue need health checks so `depends_on: condition: service_healthy` works (the existing `db` service already uses a healthcheck). The key scheme is cited by storage code, worker, presign logic, tests and any future deletion — a cross-component contract. Phase 04's custom thumbnails are out of scope.

**Options:**

### Option A: One bucket `streamtube`, prefixed keys by internal video id
- Keys: `videos/{videoUuid}/original` (content type kept as object metadata) and `videos/{videoUuid}/thumbnail.jpg`. Keyed by the internal `uuid` PK, not the public id (TD-07), so the public id can never be a storage-layout constraint. Bucket name from `S3_BUCKET`.
- **Pros:** One bucket to create, protect and configure (CORS, lifecycle); deleting a video is one prefix; trivially extensible (`…/thumbnail-custom`, Phase 04).
- **Cons:** Per-type policies (lifecycle, public read for thumbnails) need prefix rules rather than bucket-level settings.

### Option B: Separate buckets per asset type (`streamtube-videos`, `streamtube-thumbnails`)
- **Pros:** Bucket-level policy per type (e.g. public thumbnails, private originals).
- **Cons:** More provisioning, CORS and config keys; two buckets to keep consistent in tests; engine bucket-count limits are irrelevant here but cost is not.

### Option C: Bucket per video or per channel
- **Pros:** Strong isolation.
- **Cons:** Not viable at scale (bucket creation per upload, naming limits); rejected, listed only to rule out.

**Recommendation:** **Option A**. Provisioning: a one-shot Compose init service (the engine's `mc` client, e.g. `pgsty/mc` if TD-13 picks Silo) that runs `mb --ignore-existing` and applies CORS/lifecycle where supported, with `nestjs-api` and `video-worker` depending on it (`service_completed_successfully`) — preferable to API-on-boot creation, which needs bucket-create permission at runtime and races between API and worker. Tests call an idempotent `CreateBucket` for a dedicated test bucket in setup (TD-12). Health checks: the object-storage probe depends on the chosen image (MinIO exposes `/minio/health/live` and `/minio/health/ready`; whether `curl` or `mc` exists in the image must be checked at implementation) and `redis-cli ping` for Redis if TD-01 = A. Publish storage `9000`/`9001`; never publish Redis.

**Decision:** A (single bucket `streamtube`, keys `videos/{uuid}/original` and `videos/{uuid}/thumbnail.jpg`, Compose init service provisions the bucket).

**Libraries:** —

---

## TD-11: Authorization Model

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** The global `JwtAuthGuard` (`APP_GUARD`) protects every route unless `@Public()` is applied; the `JwtPayload` has only `sub` (user id) and `email`; channels are 1:1 with users through unique `channels.user_id`; services throw `DomainException`s mapped by filters (`nestjs-services.md`). The video must belong to a channel (migration FK), and only the owning channel may initiate, request part URLs, complete, abort or read its upload/processing status. `docs/project-plan.md` §1 says anonymous users watch freely and social features need auth — upload management is authenticated; viewing rules are in TD-08.

**Options:**

### Option A: Resolve the channel from `sub` in the service; ownership check per request, 404 for foreign videos
- `VideosService` loads the caller's channel by `user_id` (indexed, unique) and filters every video query by `channel_id`. A video that does not exist or belongs to another channel yields the same `VideoNotFoundException` (404), avoiding id enumeration. Management routes use the default guard; streaming/download routes carry `@Public()` per TD-08.
- **Pros:** No change to Phase 02's token contract; the single source of truth is the DB; matches existing layering (guard authenticates, service authorizes).
- **Cons:** One extra indexed lookup per request.

### Option B: Add `channelId` to the JWT payload
- **Pros:** No lookup per request.
- **Cons:** Modifies the decided Phase 02 token shape and issuance; stale claims if the channel changes; unnecessary since the lookup is cheap.

### Option C: Dedicated `VideoOwnerGuard` + decorator
- A guard resolves and attaches the owned video/channel to the request.
- **Pros:** Reusable across controllers (Phase 04 edit endpoints).
- **Cons:** Authorization logic leaves the service layer, against the project's layering rule; more indirection for two or three routes.

**Recommendation:** **Option A** — it respects the inherited layering, needs no auth changes, and returns 404 uniformly for "not yours". Public surface: only the stream and download endpoints (TD-08, pending its open question); upload initiate/part-urls/complete/abort and the owner's status endpoint stay behind the global guard. Only users with a confirmed account can log in (Phase 02), so no extra confirmation check is added.

**Decision:** A (channel resolved from the JWT `sub`; 404 for a video of another channel).

**Libraries:** —

---

## TD-12: Test Strategy and Fixtures

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo", "URL única por vídeo, sem conflito com outros vídeos", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Root and `nestjs-project/CLAUDE.md` fix the pyramid: `*.spec.ts` (mocks, no I/O), `*.integration-spec.ts` (real DB/services, in-band) and `*.e2e-spec.ts` (full HTTP via supertest); tests run inside `nestjs-api` and reach services by Compose name; no new suffix without changing `testRegex`. A 10GB file cannot be uploaded in a test; S3 forbids parts below 5 MiB except the last.

**Options:**

### Option A: Real Compose services (storage, Redis if TD-01 = A, Postgres) + fixtures generated at test time with ffmpeg `lavfi`
- Integration specs use the real storage, queue and DB; sample videos are generated in `beforeAll` with `ffmpeg -f lavfi -i testsrc=…` (plus a non-faststart MP4 variant, i.e. without `-movflags +faststart`, and a corrupt file for the failure path) into a temp dir, no binary committed. Multipart tested with the configurable part size set to 5 MiB and a fixture of ≥ 6 MiB (two parts, minimum-size rule exercised); the 10GB/10,000-part arithmetic is covered by a unit test of the part planner, not by uploading. E2E imports both `AppModule` and `WorkerModule` in-process and runs: register/login → initiate → PUT parts to presigned URLs (host-override helper from TD-03) → complete → poll until `ready` → stream redirect → Range request returns `206`. Isolation: per-run test bucket, queue `prefix`/obliterate in `beforeEach`, DB cleanup extended in `cleanAllTables`; `ffmpeg` in the `nestjs-api` image (TD-05).
- **Pros:** Exercises real behavior (presign signatures, multipart ETags, retries, ffprobe) where bugs actually live; matches existing conventions; no committed binaries.
- **Cons:** Needs `docker compose up` of storage/queue before the suite; slower than mocks; requires generous per-test timeouts for e2e.

### Option B: Testcontainers
- Tests start their own MinIO/Redis containers.
- **Pros:** Self-contained, parallel-safe.
- **Cons:** Requires Docker socket access inside `nestjs-api` (not available today) and contradicts the project's "use the Compose services" convention.

### Option C: Fakes/mocks of storage and queue (aws-sdk-client-mock, in-memory queue)
- **Pros:** Fast, no infrastructure.
- **Cons:** Cannot catch SigV4 host mismatches, multipart part-size rules, ETag handling or ffprobe behavior; acceptable only for unit tests, not as the integration/e2e layer.

**Recommendation:** **Option A**, with Option C only for `*.spec.ts` unit tests of services. Pending question for the user: whether "10GB" means 10 GiB (10,737,418,240 bytes) or 10 GB (10,000,000,000 bytes) for `UPLOAD_MAX_BYTES`; the recommendation is 10 GiB (the larger, safer reading; the part planner works in both). **Confirmed by the user (2026-11-05):** `UPLOAD_MAX_BYTES` = 10 GiB (10,737,418,240 bytes) — see TD-02.

**Decision:** A (real Compose services + ffmpeg `lavfi` fixtures; `WorkerModule` imported in-process). `UPLOAD_MAX_BYTES` follows TD-02 (10 GiB).

**Libraries:** —

---

## TD-13: Object Storage Engine

**Scope:** Backend

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** `docs/diagrams/software-arch.mermaid` and `README.md` say "S3 or MinIO". Research on 2026-11-05 shows upstream MinIO is no longer a safe default. Primary evidence (checked via the GitHub and Docker Hub APIs): `github.com/minio/minio` is archived (`archived: true`, last push 2026-04-24), its latest release is `RELEASE.2025-10-15T17-29-55Z`, and the `minio/minio` repository on Docker Hub returns "object not found" (the `quay.io/minio/minio` situation was not verified). Secondary sources (blogs, not MinIO announcements) describe community images and binaries stopping in October 2025 and maintenance mode in December 2025. Application code will use the AWS SDK against a configurable endpoint (TD-03), so engine choice is a Compose/config decision; the Silo/Garage/SeaweedFS behaviors below must be confirmed in a spike (multipart, presign, CORS, ListParts).

**Options:**

### Option A: `pgsty/silo` (community MinIO fork, drop-in S3 and `MINIO_*` env compatibility)
- Docker Hub `pgsty/silo` (latest tag pushed 2026-10-26, release `RELEASE.2026-10-26T00-00-00Z`; renamed from `pgsty/minio` on 2026-08-06), console restored, AGPL-3.0-or-later, paired with `pgsty/mc` (also on Docker Hub). Upstream compatibility is described as best effort ([repo](https://github.com/pgsty/minio)).
- **Pros:** Same code base MinIO users know (root user/password env, `mc`, bucket notifications and the global CORS setting); smallest change from the project's documented "MinIO"; actively released.
- **Cons:** Single-vendor community fork with a short track record (reported by commentators); not affiliated with MinIO Inc.; AGPL; stale-upload and lifecycle behavior inherited from MinIO (reported limits in TD-02).

### Option B: Garage (`dxflrs/garage`, v2.5.0 pushed 2026-10-24)
- Lightweight S3 server. Documented support: multipart (Create/UploadPart/Complete/Abort/ListParts), SigV4 presigned URLs, lifecycle `AbortIncompleteMultipartUpload` and `Expiration`, bucket CORS ([S3 compatibility](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)); bucket notifications not supported.
- **Pros:** Actively maintained; covers the exact S3 surface this phase uses, including orphan-upload lifecycle; small footprint.
- **Cons:** Needs a config file plus bootstrap commands (layout assign, key/bucket create) in an init service — more Compose complexity than MinIO's env-only start; no bucket notifications (rules out TD-04 option B); Range-GET behavior not stated on the compatibility page (spike).

### Option C: SeaweedFS (`chrislusf/seaweedfs`, Apache 2.0)
- S3 gateway on top of a volume store. Documented: multipart, presigned (SigV4), CORS, Range reads ([wiki](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API)); bucket notifications not supported; lifecycle `AbortIncompleteMultipartUpload` not mentioned on the page.
- **Pros:** Permissive license; scales well for many objects.
- **Cons:** More components (master/volume/filer/S3) to run for a development stack; documented S3 gaps; least aligned with the "S3 or MinIO" wording.

### Option D: Upstream MinIO pinned to a final image/binary built from source
- Use the last released source/image (`RELEASE.2025-10-15…`) or build from the archived repo.
- **Pros:** Exactly what existing MinIO docs/tutorials describe.
- **Cons:** No security fixes (archived); no official image on Docker Hub; building from source in Compose is a maintenance burden; ill-advised for a platform storing user uploads.

**Recommendation:** **Option A (`pgsty/silo` with `pgsty/mc`) for the Compose dev/test stack**, keeping all code engine-agnostic (AWS SDK + `S3_*` env, no MinIO-only APIs, no dependency on bucket notifications) so Garage or real S3 is a configuration swap; Option B (Garage) is the better pick if the user prioritizes a maintained project over Compose simplicity. The user should confirm the engine knowing upstream MinIO is archived; the architecture docs ("S3 or MinIO") then need a note when this TD is decided. **Confirmed by the user (2026-11-05):** `pgsty/silo` with `pgsty/mc`; application code uses only the S3 API, and the "S3 or MinIO" wording in the project docs is satisfied by this S3-compatible MinIO fork.

**Decision:** A (`pgsty/silo` + `pgsty/mc`, maintained MinIO fork). Application code uses only the AWS S3 API (no engine-specific features), so the engine is a Compose/config swap. Documentation note: the "S3 or MinIO" wording in the project overview, architecture diagram and `CLAUDE.md` is satisfied by this S3-compatible MinIO fork.

**Libraries:** —

---

## TD-14: Thumbnail Frame, Format and Size

**Scope:** Backend

**Capability:** "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Continues TD-06: ffmpeg extracts one frame after ffprobe has produced the duration. The result is stored as `videos/{id}/thumbnail.jpg` (TD-10) and consumed by listings in Phases 04 and 07, so format and dimensions are a cross-phase contract. Videos can be seconds long or hours long.

**Options:**

### Option A: Frame at a fraction of the duration (e.g. 10%, clamped to ≥ 1s and ≤ duration)
- `ffmpeg -ss <t> -i <input> -frames:v 1 -vf scale='min(1280,iw)':-2 -q:v 3 thumbnail.jpg`, with `-ss` before `-i` (fast seek, uses Range reads over HTTP).
- **Pros:** Deterministic, one seek, cheap on 10GB inputs; avoids black first frames typical of fixed `t=0`; works for any duration.
- **Cons:** May still land on a transition or dark scene.

### Option B: Fixed timestamp (e.g. t = 1s)
- **Pros:** Simplest.
- **Cons:** Fails on videos shorter than 1s; frequently a black or title frame.

### Option C: ffmpeg `thumbnail` filter (picks a representative frame from a window of frames)
- **Pros:** Better visual quality on average.
- **Cons:** Decodes N frames per attempt (CPU and extra reads on huge files over HTTP); non-deterministic across ffmpeg versions; slower pipeline for marginal gain in this phase.

**Recommendation:** **Option A**, JPEG output (universal browser support; WebP is a later optimization), max width 1280 px with aspect ratio preserved (even height), quality around `-q:v 3`, timeout-bounded, saved with `Content-Type: image/jpeg`. Open sub-question for the user: if the thumbnail step fails after metadata extraction succeeded, should the video still become `ready`? The safe default proposed here is to treat it as a processing failure (`error`), so `ready` always implies a thumbnail. **Confirmed by the user (2026-11-05):** if the thumbnail step fails after metadata extraction the video becomes `error`, so `ready` implies duration and thumbnail present.

**Decision:** A (frame at 10% of the duration, JPEG, max width 1280 px). Confirmed by the user: if the thumbnail step fails after metadata extraction, the video becomes `error` (`ready` implies duration and thumbnail present).

**Libraries:** —

---

## TD-15: Accepted Upload Formats and Content Types

**Scope:** Backend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" (also "Processamento automático do vídeo após upload (extração de duração e metadados)" — ffprobe is where an unsupported file is detected)

**Context:** The initiate endpoint (TD-02) receives the file name, declared size and content type before any byte is uploaded, so it is the cheapest place to reject an obviously wrong upload, but `docs/project-plan.md` does not fix which container formats or MIME types are accepted. The declared content type is client-supplied and not trustworthy; the only authoritative check is ffprobe on the stored object (TD-06), whose failure is a non-retryable processing error (TD-09). Because Phase 03 plays back the original file (no transcoding — see header), browser playability of exotic containers is a Phase 05 concern, not decided here. Depends on TD-02, TD-06, TD-09.

**Options:**

### Option A: Allowlist of MIME types configured by env (e.g. `video/mp4,video/webm,video/quicktime,video/x-matroska`)
- The initiate endpoint rejects any declared content type outside `UPLOAD_ALLOWED_MIME_TYPES` with a `400`/`415`-style domain error; the worker still runs ffprobe.
- **Pros:** Rejects wrong uploads before any bytes are sent; explicit and testable; the allowlist is operator-tunable.
- **Cons:** The list is an invented product decision (nothing in `docs/project-plan.md` fixes it); the declared MIME type is spoofable and browsers report empty/odd types for some containers (`.mkv`, `.mov`), producing false rejections; still needs ffprobe as the real gate.

### Option B: Accept any `video/*` declared type at initiate; ffprobe is the real validator
- Initiate only checks that the declared content type starts with `video/` (cheap sanity check against obvious misuse); the worker's ffprobe decides whether the file is a decodable video (at least one video stream). An ffprobe failure or a file with no video stream throws `UnrecoverableError` and the video becomes `error` with a reason (TD-09).
- **Pros:** No invented format list; one authoritative validator (ffprobe understands far more containers than any list we would maintain); false rejections from browser MIME quirks are limited to non-`video/*` types; consistent with the failure policy already in TD-09.
- **Cons:** A spoofed or wrong file is only detected after the whole upload (up to 10 GiB) completes; a non-video file with a `video/*` type consumes storage until processing fails.

### Option C: No pre-validation at initiate; ffprobe is the only gate
- Initiate accepts any content type; everything is decided by ffprobe after upload.
- **Pros:** Simplest; no false rejections at initiate.
- **Cons:** Any file type can be uploaded up to the size limit and stored before being rejected; no cheap protection against accidental misuse; the stored content type becomes arbitrary client input.

**Recommendation:** **Option B (`video/*` + ffprobe as the real validator)** — it avoids inventing a format list that the project plan does not define while still failing fast on clearly non-video content types; ffprobe (TD-06) is the authoritative check and its failure maps to the already-decided non-retryable `error` path (TD-09). Option A is the stricter alternative if the product later defines a supported-format list (configurable via env, so no code change). The accepted content type is stored as object metadata (TD-10) and returned with `ResponseContentType` on streaming (TD-08).

**Decision:** B (accept `video/*` declared type at initiate; ffprobe is the real validator — an ffprobe failure or a file with no video stream is a non-retryable error, TD-09).

**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Job queue technology | A — BullMQ + Redis (unpublished) | A (BullMQ + Redis) |
| TD-02 | Cross-layer | Upload strategy for files up to 10GB | A — S3 multipart + per-part presigned URLs | A (S3 multipart + per-part presigned URLs; 10 GiB; resume in scope) |
| TD-03 | Cross-layer | Presigned URL host / endpoint configuration | A — `S3_ENDPOINT` + `S3_PUBLIC_ENDPOINT`, separate presign client | A (`S3_ENDPOINT` + `S3_PUBLIC_ENDPOINT`) |
| TD-04 | Backend | Processing trigger and job idempotency | A — `complete` endpoint enqueues (+ sweeper) | A (`complete` endpoint enqueues + sweeper) |
| TD-05 | Backend | Worker location and runtime | A — same codebase, separate entrypoint and container | A (same codebase, autostart worker service) |
| TD-06 | Backend | Metadata extraction and FFmpeg invocation | A — direct spawn, ffprobe/ffmpeg over internal presigned URL | A (direct spawn; normalized columns + JSONB) |
| TD-07 | Backend | Public video identifier | A — 11-char base62 via `node:crypto` + unique constraint/retry | A (11-char base62) |
| TD-08 | Cross-layer | Streaming and download delivery | A — authorize then redirect to presigned GET | A (authorize + redirect; anonymous `ready`) |
| TD-09 | Backend | Status lifecycle, failure handling, abandoned uploads | A — single enum `draft→processing→ready/error` + sweeper | A (single enum; BullMQ job scheduler sweeper) |
| TD-10 | Backend | Bucket layout, keys and provisioning | A — single bucket, `videos/{uuid}/…`, init container | A (single bucket, init container) |
| TD-11 | Backend | Authorization model | A — channel from `sub`, 404 for foreign videos | A (channel from `sub`) |
| TD-12 | Backend | Test strategy and fixtures | A — real Compose services + lavfi fixtures + in-process worker e2e | A (real services + lavfi fixtures) |
| TD-13 | Backend | Object storage engine | A — `pgsty/silo` (upstream MinIO is archived) | A (`pgsty/silo` + `pgsty/mc`) |
| TD-14 | Backend | Thumbnail frame, format and size | A — 10% of duration, JPEG, max 1280px | A (10%, JPEG, 1280px; failure => error) |
| TD-15 | Backend | Accepted upload formats and content types | B — `video/*` at initiate + ffprobe as real validator | B (`video/*` + ffprobe) |
