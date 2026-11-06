---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.27
target_file: nestjs-project/test/videos-stream.e2e-spec.ts
---

# GET /videos/:id/stream Test Plan

## Application Overview

Rota pública que redireciona (302) para uma URL pré-assinada de `GetObject` no storage; o `206`/`Content-Range`/`Accept-Ranges` é emitido pelo storage, não pela API. Só vídeos `ready`. Origem: SI-03.27 e `### API Contracts → GET /videos/:id/stream`.

## Test Scenarios

### 1. GET /videos/:id/stream — streaming público

**Setup:** mesmo bootstrap dos demais specs de vídeo (`AppModule`, pipes/filtros do `main.ts`, bucket de teste dedicado, `cleanAllTables` no `beforeEach`). Vídeo `ready` semeado: usuário dono com canal, arquivo de `generateSampleVideo()` enviado para `videos/<uuid>/original` no bucket de teste e linha em `videos` com `status = ready` e `content_type = video/mp4`. Vídeos `draft`/`processing`/`error` semeados por insert direto. Requisições ao `Location` usam `requestPresignedUrl` (host override); supertest com `.redirects(0)`.

#### 1.1. anonymous-stream-redirects-to-public-storage-host

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. GET /videos/:id/stream sem Authorization para o vídeo `ready`
    - expect: status 302
    - expect: header `Location` com host de `S3_PUBLIC_ENDPOINT` e caminho `videos/<uuid>/original`

#### 1.2. location-with-range-returns-206

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. GET /videos/:id/stream (302) e requisição à URL do `Location` com `Range: bytes=0-99`
    - expect: status 206 com `Content-Range` iniciando em `bytes 0-99/` e `Accept-Ranges` presente
    - expect: `Content-Type` igual ao `content_type` salvo

#### 1.3. non-ready-or-unknown-video-returns-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. GET /videos/:id/stream para vídeos em `draft`, `processing` e `error` (um por vez)
    - expect: status 404 e `error: "VIDEO_NOT_FOUND"` em cada um
  2. GET /videos/aaaaaaaaaaa/stream (id inexistente)
    - expect: status 404 e `error: "VIDEO_NOT_FOUND"`
