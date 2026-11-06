---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: nestjs-project/test/videos-part-urls.e2e-spec.ts
---

# POST /videos/:id/upload/part-urls Test Plan

## Application Overview

Emite (ou reemite) URLs pré-assinadas de `UploadPart` para os números de parte pedidos, apenas para o dono de um rascunho válido (não expirado). Origem: SI-03.14 e `### API Contracts → POST /videos/:id/upload/part-urls`.

## Test Scenarios

### 1. POST /videos/:id/upload/part-urls — URLs por parte

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] })` + `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` + `DomainExceptionFilter`/`ValidationExceptionFilter` (replicar `main.ts`); bucket de teste dedicado (`src/test/storage-test.ts`) e prefixo de fila único (`src/test/queue-test.ts`); `UPLOAD_PART_SIZE_BYTES=5242880`. `beforeEach`: `cleanAllTables` + helper `registerConfirmAndLogin(email)` (padrão de `test/auth.e2e-spec.ts`) para o usuário dono (cria canal 1:1) e um segundo usuário "outro". Cada cenário parte de um rascunho do dono criado por `POST /videos` (`size_bytes = 6291456` → 2 partes); estados `processing`/expirado são forçados por update direto na linha de `videos` via DataSource.

#### 1.1. owner-gets-presigned-urls

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com Bearer do dono e `{ part_numbers: [1, 2] }`
    - expect: status 200
    - expect: `parts` com 2 entradas `{ part_number, url }` (números 1 e 2), cada `url` aponta para o host de `S3_PUBLIC_ENDPOINT`
    - expect: `expires_in` igual a `PRESIGN_EXPIRES_SECONDS`

#### 1.2. other-user-gets-404

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST /videos/:id/upload/part-urls com Bearer do outro usuário autenticado e `{ part_numbers: [1] }`
    - expect: status 404 e `error: "VIDEO_NOT_FOUND"`

#### 1.3. part-number-out-of-range-returns-400

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST com Bearer do dono e `{ part_numbers: [3] }` (`part_count = 2`)
    - expect: status 400 e `error: "INVALID_PART_NUMBER"`
  2. POST com Bearer do dono e `{ part_numbers: [] }`
    - expect: status 400 e `error: "VALIDATION_ERROR"`

#### 1.4. video-not-in-draft-returns-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. Forçar `status = processing` na linha do vídeo; POST com Bearer do dono e `{ part_numbers: [1] }`
    - expect: status 409 e `error: "VIDEO_NOT_IN_DRAFT"`

#### 1.5. expired-draft-returns-410

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. Forçar `upload_expires_at` no passado na linha do rascunho; POST com Bearer do dono e `{ part_numbers: [1] }`
    - expect: status 410 e `error: "UPLOAD_EXPIRED"`

#### 1.6. part-urls-without-token-returns-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST /videos/:id/upload/part-urls sem Authorization
    - expect: status 401
