---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.18
target_file: nestjs-project/test/videos-get-status.e2e-spec.ts
---

# GET /videos/:id (status do dono) Test Plan

## Application Overview

Permite ao dono acompanhar o ciclo de status (rascunho, processando, pronto, erro) e os metadados do vídeo, sem expor `upload_id` nem `metadata`. Origem: SI-03.18 e `### API Contracts → GET /videos/:id`.

## Test Scenarios

### 1. GET /videos/:id — status do dono

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] })` + `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` + `DomainExceptionFilter`/`ValidationExceptionFilter` (replicar `main.ts`); bucket de teste dedicado (`src/test/storage-test.ts`) e prefixo de fila único (`src/test/queue-test.ts`); `UPLOAD_PART_SIZE_BYTES=5242880`. `beforeEach`: `cleanAllTables` + helper `registerConfirmAndLogin(email)` (padrão de `test/auth.e2e-spec.ts`) para o usuário dono (cria canal 1:1) e um segundo usuário "outro". Vídeos `ready` e `error` são semeados por insert direto na tabela `videos` (DataSource) sob o canal do dono, com `public_id` conhecido.

#### 1.1. owner-reads-fresh-draft

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. POST /videos (dono) e GET /videos/:id com Bearer do dono
    - expect: status 200 com `status: "draft"`
    - expect: `duration_seconds`, `width`, `height`, `video_codec`, `container_format`, `bitrate_bps`, `error_code`, `error_message` todos `null`

#### 1.2. ready-video-exposes-metadata

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. Semear vídeo `ready` com metadados preenchidos; GET /videos/:id com Bearer do dono
    - expect: status 200 com `status: "ready"`
    - expect: `duration_seconds`, `width`, `height`, `video_codec`, `container_format` e `bitrate_bps` iguais aos semeados (números, não strings)

#### 1.3. error-video-exposes-error-fields

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. Semear vídeo `error` com `error_code = "UNREADABLE_MEDIA"` e `error_message`; GET com Bearer do dono
    - expect: status 200 com `status: "error"`, `error_code` e `error_message` preenchidos

#### 1.4. other-user-and-unknown-id-return-same-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. GET /videos/:id existente com Bearer do outro usuário
    - expect: status 404 e `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/aaaaaaaaaaa (id inexistente) com Bearer do dono
    - expect: status 404 e body idêntico ao do passo 1

#### 1.5. get-status-without-token-returns-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. GET /videos/:id sem Authorization
    - expect: status 401

#### 1.6. response-never-leaks-upload-id-or-metadata

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. Semear vídeo `ready` com `upload_id` e `metadata` não nulos; GET com Bearer do dono
    - expect: status 200
    - expect: body não possui as propriedades `upload_id` nem `metadata`
