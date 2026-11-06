---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.17
target_file: nestjs-project/test/videos-abort-upload.e2e-spec.ts
---

# DELETE /videos/:id/upload Test Plan

## Application Overview

Cancela um upload em andamento: aborta o multipart no storage e remove a linha do rascunho. Só o dono, só em `draft`. Origem: SI-03.17 e `### API Contracts → DELETE /videos/:id/upload`.

## Test Scenarios

### 1. DELETE /videos/:id/upload — abortar

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] })` + `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` + `DomainExceptionFilter`/`ValidationExceptionFilter` (replicar `main.ts`); bucket de teste dedicado (`src/test/storage-test.ts`) e prefixo de fila único (`src/test/queue-test.ts`); `UPLOAD_PART_SIZE_BYTES=5242880`. `beforeEach`: `cleanAllTables` + helper `registerConfirmAndLogin(email)` (padrão de `test/auth.e2e-spec.ts`) para o usuário dono (cria canal 1:1) e um segundo usuário "outro". Cada cenário parte de um rascunho do dono criado por `POST /videos`.

#### 1.1. owner-aborts-draft-returns-204

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. DELETE /videos/:id/upload com Bearer do dono
    - expect: status 204 sem corpo
  2. GET /videos/:id com Bearer do dono
    - expect: status 404 e `error: "VIDEO_NOT_FOUND"`
    - expect: DB: linha removida; `ListParts` do `upload_id` anterior falha com `NoSuchUpload`

#### 1.2. other-user-gets-404-and-draft-remains

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. DELETE com Bearer do outro usuário
    - expect: status 404 e `error: "VIDEO_NOT_FOUND"`
    - expect: DB: a linha do rascunho continua existindo com `upload_id` preenchido

#### 1.3. processing-video-returns-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. Forçar `status = processing` na linha; DELETE com Bearer do dono
    - expect: status 409 e `error: "VIDEO_NOT_IN_DRAFT"`
    - expect: DB: linha continua existindo

#### 1.4. abort-without-token-returns-401

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. DELETE /videos/:id/upload sem Authorization
    - expect: status 401
