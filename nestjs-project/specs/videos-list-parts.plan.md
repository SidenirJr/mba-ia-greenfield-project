---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.15
target_file: nestjs-project/test/videos-list-parts.e2e-spec.ts
---

# GET /videos/:id/upload/parts Test Plan

## Application Overview

Lista as partes já gravadas no storage (`ListParts`) para o dono retomar um upload interrompido (origem `docs/project-plan.md` §4 "Pontos de Atenção"). Origem: SI-03.15 e `### API Contracts → GET /videos/:id/upload/parts`.

## Test Scenarios

### 1. GET /videos/:id/upload/parts — retomada

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] })` + `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` + `DomainExceptionFilter`/`ValidationExceptionFilter` (replicar `main.ts`); bucket de teste dedicado (`src/test/storage-test.ts`) e prefixo de fila único (`src/test/queue-test.ts`); `UPLOAD_PART_SIZE_BYTES=5242880`. `beforeEach`: `cleanAllTables` + helper `registerConfirmAndLogin(email)` (padrão de `test/auth.e2e-spec.ts`) para o usuário dono (cria canal 1:1) e um segundo usuário "outro". Cada cenário parte de um rascunho do dono criado por `POST /videos` (`size_bytes = 6291456` → 2 partes). O envio de partes usa `requestPresignedUrl` de `src/test/storage-test.ts` (host override) e captura o header `ETag`.

#### 1.1. lists-uploaded-part-after-put

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST part-urls `{ part_numbers: [1] }` e PUT de 5 MiB na URL da parte 1 (capturar `ETag`)
    - expect: PUT responde 200 com `ETag`
  2. GET /videos/:id/upload/parts com Bearer do dono
    - expect: status 200 com `part_size = 5242880`, `part_count = 2`
    - expect: `parts` contém `{ part_number: 1, size: 5242880, etag }` com o `etag` capturado e não contém a parte 2

#### 1.2. lists-empty-parts-before-any-upload

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. GET /videos/:id/upload/parts com Bearer do dono sem ter enviado nenhuma parte
    - expect: status 200 com `parts: []`

#### 1.3. other-user-gets-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. GET /videos/:id/upload/parts com Bearer do outro usuário
    - expect: status 404 e `error: "VIDEO_NOT_FOUND"`

#### 1.4. not-in-draft-returns-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. Forçar `status = processing` na linha; GET com Bearer do dono
    - expect: status 409 e `error: "VIDEO_NOT_IN_DRAFT"`

#### 1.5. expired-draft-returns-410

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. Forçar `upload_expires_at` no passado; GET com Bearer do dono
    - expect: status 410 e `error: "UPLOAD_EXPIRED"`

#### 1.6. list-parts-without-token-returns-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. GET /videos/:id/upload/parts sem Authorization
    - expect: status 401
