# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/31 completed

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
- **Status:** completed
- **Tests:** no tests (infra); validação manual no Compose: ffmpeg/ffprobe como `node`, Redis healthy, PING via `redis:6379`; regressão do spec do SI-03.1 5/5; tsc exit 0; lint exit 0
- **Observations:**
  - ffmpeg/ffprobe instalados na imagem: versão 5.1.9 (Debian bookworm, apt). `redis:7-alpine` baixou normalmente; `maxmemory-policy=noeviction`, `appendonly=yes`; o serviço `redis` não publica nenhuma porta (apenas `6379/tcp` interno).
  - Volumes nomeados `minio-data` e `redis-data` declarados no `compose.yaml`; `nestjs-api` agora depende de `minio-init` (completed) e `redis` (healthy).

### SI-03.3 — Dependências de fila, namespaces de configuração e validação Joi
- **Status:** completed
- **Tests:** 12 novos em src/config/env.validation.integration-spec.ts (16 no arquivo; src/config 19/19) + e2e app.e2e-spec.ts 1/1; tsc exit 0; lint exit 0
- **Observations:**
  - Instalados bullmq 6.7.x, @nestjs/bullmq 12.x e ioredis 5.x; a compatibilidade bullmq 6 x ioredis 5 será verificada no primeiro teste de integração da fila (SI-03.9), conforme library-refs.
  - Os namespaces `storage`, `redis`, `upload` e `worker` seguem o padrão `registerAs` com `parseInt` e defaults da Fase 01; `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `REDIS_*` e `S3_FORCE_PATH_STYLE` têm default no schema; o `.env.example` já tinha as `S3_*`/`REDIS_*` do SI-03.1/03.2 e agora também traz `QUEUE_PREFIX`, `UPLOAD_*`, `PRESIGN_EXPIRES_SECONDS` e as variáveis do worker (o `.env` local foi atualizado igualmente).
  - `requiredEnv` do spec existente foi estendido com as três `S3_*` obrigatórias (consequência direta do schema).

### SI-03.4 — StorageModule: clientes S3 (interno + presign) e StorageService
- **Status:** completed
- **Tests:** 12 novos passing (storage.service.spec 7, storage.service.integration-spec 4, storage.module.spec 1) + spike do SI-03.1 5/5; tsc exit 0; lint exit 0
- **Observations:**
  - Ambos os clientes usam `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'` (mesmo achado do spike); o cliente interno respeita `S3_FORCE_PATH_STYLE`, o de presign força path-style.
  - `headObject` devolve `{ contentLength, contentType }` e deixa o erro do SDK propagar (o mapeamento de erros de domínio fica no VideosService); `listParts` devolve `{ partNumber, etag, size }`; `completeMultipartUpload` recebe `{ partNumber, etag }[]`.
  - A paginação de `listParts` é coberta no unit com cliente mockado (a integração real com mais de 1000 partes foi considerada pesada demais); o bucket de teste dedicado (`test-<uuid>`) é criado e removido pelo helper `src/test/storage-test.ts`, e os testes sobrescrevem `storageConfig.KEY` para apontar para ele.
  - Consultado context7 (`/aws/aws-sdk-js-v3`): paginação de `ListParts` por `PartNumberMarker`/`NextPartNumberMarker` e `getSignedUrl` com `expiresIn` conforme implementado.

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
