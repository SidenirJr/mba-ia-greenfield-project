---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.16
target_file: nestjs-project/test/videos-complete-upload.e2e-spec.ts
---

# POST /videos/:id/upload/complete Test Plan

## Application Overview

Finaliza o multipart (`CompleteMultipartUpload`), confere o tamanho do objeto, move o vídeo para `processing` e enfileira o job de processamento (resposta 202). Origem: SI-03.16 e `### API Contracts → POST /videos/:id/upload/complete`. O worker não roda neste E2E (somente `AppModule`): o job permanece na fila de prefixo único.

## Test Scenarios

### 1. POST /videos/:id/upload/complete — finalização

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] })` + `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` + `DomainExceptionFilter`/`ValidationExceptionFilter` (replicar `main.ts`); bucket de teste dedicado (`src/test/storage-test.ts`) e prefixo de fila único (`src/test/queue-test.ts`); `UPLOAD_PART_SIZE_BYTES=5242880`. `beforeEach`: `cleanAllTables` + helper `registerConfirmAndLogin(email)` (padrão de `test/auth.e2e-spec.ts`) para o usuário dono (cria canal 1:1) e um segundo usuário "outro". Helper local `uploadAllParts(videoId, token, file)`: obtém URLs via `part-urls`, faz PUT das partes com `requestPresignedUrl` (host override) e devolve `[{ part_number, etag }]`; arquivo de `generateMultipartVideo()` (≥ 6 MiB, `src/test/video-fixtures.ts`) com `size_bytes` igual ao tamanho real.

#### 1.1. complete-moves-video-to-processing

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST /videos, enviar as 2 partes e POST /videos/:id/upload/complete com Bearer do dono e `parts` com os `etag` corretos
    - expect: status 202 com `status: "processing"`, `id` = public id, campos de metadados `null`, `error_code`/`error_message` `null`
    - expect: DB: `status = processing`, `upload_id` nulo
    - expect: fila `video-processing` contém um job `process-video-<uuid>`

#### 1.2. repeated-complete-returns-409

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. Completar o upload com sucesso (cenário 1.1) e repetir o mesmo POST complete
    - expect: status 409 e `error: "VIDEO_NOT_IN_DRAFT"`
    - expect: a fila continua com um único job `process-video-<uuid>`

#### 1.3. wrong-etag-returns-400-invalid-parts

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST complete com o `etag` da parte 1 adulterado
    - expect: status 400 e `error: "INVALID_UPLOAD_PARTS"`

#### 1.4. empty-parts-returns-400-validation

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST complete com `{ parts: [] }`
    - expect: status 400 e `error: "VALIDATION_ERROR"`

#### 1.5. size-mismatch-returns-409-and-marks-error

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST /videos com `size_bytes` diferente do tamanho real do arquivo enviado, enviar as partes e POST complete
    - expect: status 409 e `error: "UPLOAD_SIZE_MISMATCH"`
  2. GET /videos/:id com Bearer do dono
    - expect: status 200 com `status: "error"` e `error_code: "UPLOAD_SIZE_MISMATCH"`

#### 1.6. other-user-gets-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST complete com Bearer do outro usuário
    - expect: status 404 e `error: "VIDEO_NOT_FOUND"`

#### 1.7. expired-draft-returns-410

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. Forçar `upload_expires_at` no passado; POST complete com Bearer do dono
    - expect: status 410 e `error: "UPLOAD_EXPIRED"`

#### 1.8. complete-without-token-returns-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST /videos/:id/upload/complete sem Authorization
    - expect: status 401
