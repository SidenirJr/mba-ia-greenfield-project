---
libs:
  bullmq:
    version: "^6.7.0"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-05T17:46:14-03:00"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-05T17:46:14-03:00"
  ioredis:
    version: "^5.11.1"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-11-05T17:46:14-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1163.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-05T17:46:14-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1163.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-05T17:46:14-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-05T17:46:44-03:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this slice. Pulled via Context7 (BullMQ docs at v6.5.3, `@nestjs/bullmq` docs from `/nestjs/bull`, AWS SDK v3.1153.0 docs; npm latest versions confirmed with `npm view` inside `nestjs-api` on 2026-11-05). Re-fetch when the underlying TD changes.

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7, High reputation) — `phase-03-videos/TD-01` (queue), `TD-04` (deterministic job id), `TD-09` (retry policy, sweeper as job scheduler).

- **Compatibility:** `bullmq@6.7.0` ships a CJS build (`main: ./dist/cjs/index.js`), so Jest 30 + ts-jest under CommonJS are unaffected for `bullmq` itself. The Nest wrapper is the exception: `@nestjs/bullmq` and `@nestjs/bull-shared` are ESM-only (see the `@nestjs/bullmq` section). Node engines `>=14.18`.
- **Redis client is an optional peer in v6.** `peerDependencies: ioredis >=5.0.0 | redis >=5.0.0 | pg` are all optional; install `ioredis` explicitly (TD-01 Libraries). Pass the connection as options (`{ host: 'redis', port: 6379 }`) or an ioredis instance. For a shared `IORedis` instance used by Workers, set `maxRetriesPerRequest: null` (BullMQ sets it for Workers by default and warns when overridden).
- **Retries / backoff:** `attempts` + `backoff` are job options. Exponential retries after `2^(attempts-1) * delay` ms:

```typescript
await queue.add('process-video', { videoId }, {
  jobId: `process-video:${videoId}`, // deterministic id (TD-04)
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
});
```

- **Non-retryable failure:** throwing `UnrecoverableError` from the processor moves the job to `failed` without retries, overriding `attempts` (TD-09: corrupt file / no video stream, TD-15):

```typescript
import { UnrecoverableError } from 'bullmq';
throw new UnrecoverableError('no video stream');
```

- **Dedup:** besides a custom `jobId`, v6 offers `deduplication: { id }` (ignores new jobs with the same id while the existing one is not completed/failed). TD-04 uses the deterministic `jobId`.
- **Job scheduler (sweeper, TD-09)** — replaces v5 repeatable jobs. `upsertJobScheduler(schedulerId, repeatOptions, template)` is idempotent, so calling it on every worker boot is safe. Repeat options: `pattern` (cron with seconds) or `every` (ms). Jobs produced by a scheduler **cannot have a custom job id**.

```typescript
await queue.upsertJobScheduler(
  'video-sweeper',
  { every: 5 * 60_000 },
  { name: 'sweep', data: {}, opts: { attempts: 3, backoff: 3000, removeOnFail: 1000 } },
);
```

- **Production notes (from TD-01 Cons):** Redis needs `maxmemory-policy noeviction` (and AOF persistence recommended) — set in the Compose `command`. Terminal failures stay in the `failed` set; the video row (`error` + reason) is the dead-letter record. Test isolation: queue `prefix` + `obliterate`.

## @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7, High reputation) — `phase-03-videos/TD-01`, `TD-05`.

- **Compatibility:** `@nestjs/bullmq@12.0.0` peers: `@nestjs/core|common ^10 || ^11 || ^12`, `bullmq ^3 - ^6` — installs on Nest 11.1.x.
- **ESM-only (correction found in SI-03.9):** `@nestjs/bullmq@12.0.1` and `@nestjs/bull-shared@12.0.1` declare `"type": "module"`, unlike `bullmq`, which ships a CJS build. Jest (CommonJS) fails with `Unexpected token 'export'` unless `transformIgnorePatterns` lets these two packages through and a `transform` entry compiles them with `ts-jest` (`allowJs`, `module: commonjs`). Both are configured in `nestjs-project/package.json` (jest) and `nestjs-project/test/jest-e2e.json` — keep them. At runtime Node 25 loads the packages through `require` without changes.
- **Module wiring:** `BullModule.forRootAsync({ useFactory, inject })` for the shared Redis connection (inject the namespaced `redis` config via `registerAs` per phase-01 TD-03), then `BullModule.registerQueue({ name, defaultJobOptions })` per queue.

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [redisConfig.KEY],
  useFactory: (cfg: ConfigType<typeof redisConfig>) => ({ connection: { host: cfg.host, port: cfg.port } }),
});
```

- **Producer:** inject with `@InjectQueue('video-processing') private readonly queue: Queue`; call `queue.add(name, data, opts)`.
- **Consumer:** `@Processor('video-processing', { concurrency })` on a class extending `WorkerHost` with `async process(job: Job)`. `@OnWorkerEvent('failed')` (class must be a `@Processor`) is the hook to set the video to `error` after attempts are exhausted (check `job.attemptsMade >= job.opts.attempts` or `UnrecoverableError`).
- **Process split (TD-05):** a `@Processor` class creates a BullMQ `Worker` wherever it is provided. Provide the processor **only** in `WorkerModule` (bootstrapped by `NestFactory.createApplicationContext` in `src/worker.ts`); `AppModule` must import only the producer side (queue registration without the processor), otherwise the API process also consumes jobs. Workers and queues are closed on application shutdown (enable shutdown hooks in the worker entrypoint).

## ioredis

**Source:** `/redis/ioredis` (Context7, High reputation; versions v5.11.1 and v6.0.0 listed). `phase-03-videos/TD-01`.

- BullMQ 6 declares `ioredis >=5.0.0` as an optional peer; npm `latest` is 6.0.0 but this phase pins **`^5.11.1`** (5.x line, the one BullMQ's docs/examples are written against) to avoid an unverified major — **plan-build must verify** that `bullmq@6.7.0` boots against the installed ioredis in the first integration test, and may move to 6.x only if that passes.
- Connect by service name (`host: 'redis'`), never `localhost`.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` v3.1153.0 (Context7, High reputation; npm latest is 3.1163.0). `phase-03-videos/TD-02`, `TD-03`, `TD-04`, `TD-13`. Ships CJS (`main: ./dist-cjs/index.js`) — no Jest/CJS issue.

- **Client options:** custom endpoint + path-style for MinIO-compatible engines; `requestChecksumCalculation` / `responseChecksumValidation` accept `WHEN_REQUIRED` | `WHEN_SUPPORTED` (default `WHEN_SUPPORTED` adds CRC32 headers that S3-compatible servers and browser presigned PUTs may not expect — use `WHEN_REQUIRED` on the presign client, TD-03):

```typescript
new S3Client({
  region, endpoint: process.env.S3_ENDPOINT, forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
```

- **Multipart commands used by the API (it never carries the bytes):** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `UploadId`; `ListPartsCommand({ Bucket, Key, UploadId, PartNumberMarker })` (resume, AMB-2; paginated, max 1000 parts per page); `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })`; `AbortMultipartUploadCommand`; `HeadObjectCommand` for the size check (TD-04). S3 limits: 1–10,000 parts, part size 5 MiB–5 GiB (last part exempt).
- **`@aws-sdk/lib-storage` `Upload` is NOT used in the API** (it streams bytes through the process — the rejected TD-02 Option B). It may be used in the worker only to upload the generated thumbnail if convenient; a single `PutObjectCommand` suffices for a small JPEG.
- Do not use `@aws-sdk/client-s3` `Upload`-style helpers from the browser side in this phase (frontend out of scope).

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` v3.1153.0 (Context7). `phase-03-videos/TD-02`, `TD-03`, `TD-06`, `TD-08`.

- `getSignedUrl(client, command, { expiresIn })` — default `expiresIn` is 900 s. Signing is a local computation (no network call), so the API can sign with the **public-endpoint client** (`S3_PUBLIC_ENDPOINT`) without reaching that host; the worker signs with the **internal** client for ffprobe/ffmpeg.
- Part URLs: `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn })` (one URL per requested part number; re-issuable for resume).
- Download/stream (TD-08): `new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="..."', ResponseContentType })`; Range requests go straight to storage, which answers `206`.
- To force an `x-amz-*` header to be signed and required on the request, pass `unhoistableHeaders: new Set([...])` — not needed for this phase.
- SigV4 signs the `Host` header: a URL is valid only for the host it was signed with (see TD-03 testability note: send with `node:http` `request()` and an overridden `host` header, not `fetch`).

## Caveats for plan-build

- `pgsty/silo` / `pgsty/mc` (TD-13) are Docker images, not npm libraries — not cached here; behavior (multipart, presign, CORS with `ETag` exposed, `ListParts`, Range) must be confirmed in the first spike. TD-10 init service uses `pgsty/mc`.
- `ffmpeg`/`ffprobe` are apt binaries added to `Dockerfile.dev` (TD-05/TD-06), not npm packages.
- `nanoid`, `pg-boss` and `fluent-ffmpeg` were rejected; ID generation uses `node:crypto` (TD-07). The one ESM-only exception is `@nestjs/bullmq` + `@nestjs/bull-shared` (TD-01), handled by the restricted Jest `transformIgnorePatterns` + `transform` (see the `@nestjs/bullmq` section).
