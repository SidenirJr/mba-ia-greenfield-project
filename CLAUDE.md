# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Modules in `src/`: `auth`, `users`, `channels`, `videos`, `storage`, `queue`, `media`, `worker` (video processing, separate process entrypoint `src/worker.ts`), plus `config`, `common`, `mail`, `database`. Comments, subscriptions and likes are not implemented yet.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → separate process (`nestjs-project/src/worker.ts`, Compose service `video-worker`) that consumes jobs from the queue, runs `ffprobe`/`ffmpeg` (duration/metadata + thumbnail), updates the DB and storage, and runs the sweeper (aborts expired drafts, re-enqueues stale `processing` videos)
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3-compatible) → video files and thumbnails. Runs as the Compose service `minio` using the `pgsty/silo` image (a maintained fork of MinIO, whose upstream was archived), with `minio-init` (`pgsty/mc`) creating the bucket and its CORS. This fork satisfies the "S3/MinIO" requirement of the project statement; the API talks S3 through the AWS SDK v3, so any S3-compatible engine works.
- **Message Queue** → BullMQ on Redis (Compose service `redis`, not published on the host). Queues `video-processing` (jobs `video.process`) and `video-maintenance` (sweeper scheduler)
- **Email Service** (SMTP) → account confirmation and password recovery

## Videos Module (Phase 03)

Upload goes **directly to the storage** (S3 multipart with presigned part URLs, up to 10 GiB) — the API never carries the file bytes. Stream and download are redirects to presigned storage URLs, which serve `Range` (`206`) themselves. Video status lifecycle: `draft` → `processing` → `ready` | `error`. The public video id is an 11-character base62 string.

Endpoints (`nestjs-project/src/videos/videos.controller.ts`):

| Method and route | Auth | Success | Purpose |
|------------------|------|---------|---------|
| `POST /videos` | JWT | 201 | Create the draft and open the multipart upload (returns the part plan) |
| `POST /videos/:id/upload/part-urls` | JWT, owner | 200 | Presigned PUT URL per part number |
| `GET /videos/:id/upload/parts` | JWT, owner | 200 | Part plan and parts already stored (resume) |
| `POST /videos/:id/upload/complete` | JWT, owner | 202 | Complete the multipart, move to `processing`, enqueue the job |
| `DELETE /videos/:id/upload` | JWT, owner | 204 | Abort the upload and delete the draft |
| `GET /videos/:id` | JWT, owner | 200 | Status and metadata |
| `GET /videos/:id/stream` | Public | 302 | Redirect to the presigned `GetObject` URL (only `ready` videos) |
| `GET /videos/:id/download` | Public | 302 | Same, forcing `Content-Disposition: attachment` |

HTTP errors follow the `ApiErrorEnvelope` (`VIDEO_NOT_FOUND`, `UPLOAD_EXPIRED`, `UPLOAD_SIZE_MISMATCH`, etc.); processing failures are stored on the video as `error_code` and read via `GET /videos/:id`; the contract is versioned in `nestjs-project/openapi.json` (`npm run openapi:export`). Infrastructure details, env vars and test rules are in `nestjs-project/CLAUDE.md`.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task. Run suites with the `video-worker` Compose service stopped (`docker compose stop video-worker`) and start it again afterwards (see `nestjs-project/CLAUDE.md`).
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.