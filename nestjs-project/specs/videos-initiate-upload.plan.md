---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: nestjs-project/test/videos-initiate-upload.e2e-spec.ts
---

# POST /videos (iniciar upload) Test Plan

## Application Overview

`POST /videos` pré-cadastra o vídeo como rascunho sob o canal do usuário autenticado, abre o multipart no object storage e devolve o plano de partes (`part_size`, `part_count`) que o cliente deve usar para enviar o arquivo direto ao storage. Origem: SI-03.13 e `### API Contracts → POST /videos`.

## Test Scenarios

### 1. POST /videos — iniciar upload

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] })` + `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` + `DomainExceptionFilter`/`ValidationExceptionFilter` (replicar `main.ts`); bucket de teste dedicado (`src/test/storage-test.ts`) e prefixo de fila único (`src/test/queue-test.ts`); `UPLOAD_PART_SIZE_BYTES=5242880`. `beforeEach`: `cleanAllTables` + helper `registerConfirmAndLogin(email)` (padrão de `test/auth.e2e-spec.ts`) para o usuário dono (cria canal 1:1) e um segundo usuário "outro".

#### 1.1. initiate-upload-returns-draft-and-part-plan

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST /videos com Bearer do dono e body `{ file_name: "sample.mp4", size_bytes: 6291456, content_type: "video/mp4" }`
    - expect: status 201
    - expect: `id` casa `/^[0-9A-Za-z]{11}$/`, `status = "draft"`
    - expect: `part_size` e `part_count` inteiros (5242880 e 2) e `expires_at` em ISO 8601
    - expect: DB: uma linha em `videos` com `public_id = id`, `status = draft`, `channel_id` do canal do dono e `upload_id` preenchido

#### 1.2. initiate-upload-without-token-returns-401

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST /videos sem header Authorization, body válido
    - expect: status 401
    - expect: DB: nenhuma linha em `videos`

#### 1.3. initiate-upload-size-over-limit-returns-413

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST /videos com Bearer do dono e `size_bytes = UPLOAD_MAX_BYTES + 1`
    - expect: status 413 e body `{ statusCode: 413, error: "UPLOAD_SIZE_EXCEEDS_LIMIT", message }`
    - expect: DB: nenhuma linha em `videos`

#### 1.4. initiate-upload-non-video-content-type-returns-415

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST /videos com Bearer do dono e `content_type = "application/pdf"`
    - expect: status 415 e `error: "INVALID_CONTENT_TYPE"`
    - expect: DB: nenhuma linha em `videos`

#### 1.5. initiate-upload-invalid-body-returns-400

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST /videos com Bearer do dono e body sem `file_name`
    - expect: status 400 e `error: "VALIDATION_ERROR"` com `message` array
  2. POST /videos com body válido acrescido de campo extra (`foo: "bar"`)
    - expect: status 400 e `error: "VALIDATION_ERROR"`
    - expect: DB: nenhuma linha em `videos` após os dois passos
