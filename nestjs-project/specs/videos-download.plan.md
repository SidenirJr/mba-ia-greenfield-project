---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.28
target_file: nestjs-project/test/videos-download.e2e-spec.ts
---

# GET /videos/:id/download Test Plan

## Application Overview

Rota pública que redireciona (302) para uma URL pré-assinada de `GetObject` com `response-content-disposition=attachment` assinado, para o storage emitir `Content-Disposition`. Só vídeos `ready`. Origem: SI-03.28 e `### API Contracts → GET /videos/:id/download`.

## Test Scenarios

### 1. GET /videos/:id/download — download público

**Setup:** mesmo bootstrap dos demais specs de vídeo (`AppModule`, pipes/filtros do `main.ts`, bucket de teste dedicado, `cleanAllTables` no `beforeEach`). Vídeo `ready` semeado com `original_file_name = "meu video.mp4"`, arquivo de `generateSampleVideo()` em `videos/<uuid>/original`. Vídeos não-`ready` semeados por insert direto. Requisições ao `Location` usam `requestPresignedUrl` (host override); supertest com `.redirects(0)`.

#### 1.1. anonymous-download-redirects-with-attachment-disposition

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. GET /videos/:id/download sem Authorization para o vídeo `ready`
    - expect: status 302
    - expect: `Location` contém o parâmetro `response-content-disposition` com valor iniciando em `attachment`

#### 1.2. location-returns-200-with-content-disposition

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. GET /videos/:id/download (302) e requisição à URL do `Location`
    - expect: status 200
    - expect: header `Content-Disposition` iniciando em `attachment; filename="meu video.mp4"`

#### 1.3. non-ready-or-unknown-video-returns-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-05T21:55:50Z

**Steps:**
  1. GET /videos/:id/download para vídeos em `draft`, `processing` e `error` (um por vez)
    - expect: status 404 e `error: "VIDEO_NOT_FOUND"` em cada um
  2. GET /videos/aaaaaaaaaaa/download (id inexistente)
    - expect: status 404 e `error: "VIDEO_NOT_FOUND"`
