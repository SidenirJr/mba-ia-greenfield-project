# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/31 completed

### SI-03.1 — Spike: storage S3-compatível (pgsty/silo + pgsty/mc) no Compose e contrato S3
- **Status:** completed
- **Tests:** 5/5 passing (src/storage/storage-engine.integration-spec.ts); tsc exit 0; lint exit 0
- **Observations:**
  - **Veredito do spike:** `pgsty/silo` (RELEASE.2026-10-26) atende multipart, presign (host público assinado, enviado a `minio:9000` com `host` sobrescrito via `node:http`), `ListParts` (com ETag e tamanho), `AbortMultipartUpload`, `Range` (206 + `Content-Range` + `Accept-Ranges`) e `ResponseContentDisposition`. TD-13 não precisa ser reaberta.
  - **Healthcheck:** a imagem `pgsty/silo` tem `curl` e `mc`; escolhido `curl -f http://localhost:9000/minio/health/live`. A imagem `pgsty/mc` tem `mc` (entrypoint `/usr/bin/mc`) e `sh`, mas não `curl`; o `minio-init` usa `entrypoint: ["/bin/sh", "-c"]`.
  - **CORS:** o mecanismo escolhido é o CORS de bucket via `mc cors set local/$S3_BUCKET -` (XML com `ExposeHeader ETag`), que está disponível no `pgsty/mc`; o preflight `OPTIONS` devolve `Access-Control-Allow-Origin` e `Access-Control-Expose-Headers: ETag`. A variável global `MINIO_API_CORS_ALLOW_ORIGIN` foi testada: o preflight não traz `Expose-Headers` (só as respostas reais), por isso não foi adotada.
  - **Checksums:** os clientes do spec usam `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'` (TD-03); o comportamento com `WHEN_SUPPORTED` (default do SDK) não foi testado.
  - **Idempotência:** `minio-init` roda uma segunda vez com exit 0 (`mc mb --ignore-existing`, `mc cors set` sobrescreve). `mc mb --ignore-existing` imprime "Bucket created successfully" mesmo com o bucket já existente.
  - Credenciais de dev no `.env`/`.env.example`: `S3_ACCESS_KEY_ID=streamtube`, `S3_SECRET_ACCESS_KEY=streamtube-secret` (mínimo de 8 caracteres exigido pela engine); `MAIL_FROM` não alterado. O container `nestjs-api` precisa ser recriado (`docker compose up -d`) para refletir o novo `depends_on` (feito no SI-03.2).
  - O spec limpa os objetos que cria; uploads abortados não deixam multipart pendente.

### SI-03.2 — Infra: ffmpeg no Dockerfile.dev e serviço Redis no Compose
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.3 — Dependências de fila, namespaces de configuração e validação Joi
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.4 — StorageModule: clientes S3 (interno + presign) e StorageService
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.5 — Entidade Video, migration CreateVideos e VideosModule base
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.6 — Id público base62 e VideosRepository (unicidade e transições guardadas)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.7 — Exceções de domínio de vídeos e mapeamento no filtro existente
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.8 — ChannelsService: resolver o canal do usuário autenticado
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.9 — Fila: QueueModule e produtor de jobs de processamento
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.10 — Iniciar upload: planejador de partes e VideosService.initiateUpload
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.11 — VideosService: URLs por parte e listagem de partes (retomada)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.12 — VideosService: completar (HeadObject, transição e enqueue) e abortar upload
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.13 — Endpoint POST /videos (iniciar upload)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.14 — Endpoint POST /videos/:id/upload/part-urls
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.15 — Endpoint GET /videos/:id/upload/parts (retomada)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.16 — Endpoint POST /videos/:id/upload/complete
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.17 — Endpoint DELETE /videos/:id/upload (abortar)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.18 — Endpoint GET /videos/:id (status do dono)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.19 — Helper de testes: fixtures de vídeo geradas com ffmpeg lavfi
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.20 — MediaToolsService: ffprobe e ffmpeg via child_process
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.21 — VideoPipelineService: transições de processamento e limpeza para worker e sweeper
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.22 — VideoProcessingService: metadados, thumbnail e transição para ready/error
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.23 — WorkerModule e VideoProcessingProcessor (retries, backoff e falha final)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.24 — Sweeper: job scheduler de rascunhos vencidos e reconciliação de processing
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.25 — Entrypoint worker.ts e serviço video-worker no Compose
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.26 — VideoDeliveryService: URLs pré-assinadas de streaming e download
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.27 — Endpoint GET /videos/:id/stream (redirect 302 para URL pré-assinada)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.28 — Endpoint GET /videos/:id/download (redirect 302 com Content-Disposition)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.29 — Pipeline ponta a ponta: upload multipart, processamento in-process e streaming
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.30 — Regenerar openapi.json com os endpoints de vídeo
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.31 — Documentação: CLAUDE.md raiz, nestjs-project/CLAUDE.md, README e diagrama
- **Status:** pending
- **Tests:** pending
- **Observations:** none
