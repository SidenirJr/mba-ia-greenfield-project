# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 12/31 completed

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
- **Status:** completed
- **Tests:** 8 novos (video.entity.integration-spec 7, videos.module.spec 1) + migrations.integration-spec estendido (4 testes); suíte `npm test -- --runInBand` 29 suites / 183 passing; tsc exit 0; lint exit 0
- **Observations:**
  - Migration `1793963528103-CreateVideos.ts` gerada pelo CLI contra o banco sem a tabela e aplicada (`migration:run`) no banco de dev; o SQL gerado (enum `video_status`, unique em `public_id`, índices em `channel_id` e `status`, FK `channel_id` sem cascade) coincide com o Data Model e não foi editado.
  - `duration_seconds` (numeric) também usa o transformer string para number (`numberTransformer`, junto dos `bigint`), porque o contrato da API o expõe como number e o pg devolve numeric como string; o plano só citava o `bigint`.
  - Como `Channel` agora tem `@OneToMany` para `Video`, todo `DataSource` de teste precisa registrar `Video`: `Video` foi adicionado ao array de entidades dos 10 specs existentes que listam as entidades (consequência direta da relação bidirecional, sem mudança de comportamento).
  - O spec de migrations ganhou testes de reversão do `CreateVideos` (tabela e enum), reaplicação (unique + FK) e a reversão das migrations de tokens foi mantida; o spec continua usando banco dedicado, que é descartado no `afterAll`.
  - `videos.module.spec.ts` usa um `DataSource` falso global (sem conexão), ao contrário do `channels.module.spec.ts` existente, que conecta ao banco num `*.spec.ts`; não alterado (fora de escopo).

### SI-03.6 — Id público base62 e VideosRepository (unicidade e transições guardadas)
- **Status:** completed
- **Tests:** 16 novos passing (video-public-id.util.spec 4, videos.repository.integration-spec 12); src/videos 24/24; tsc exit 0; lint exit 0
- **Observations:**
  - `createDraft` tenta no máximo 5 vezes (5 colisões consecutivas propagam o `QueryFailedError` 23505 original); a detecção da colisão procura `public_id` no `detail` do erro, como o `ChannelsService` faz para `nickname`. O helper `isPublicIdCollision` ficou privado ao repositório; o `ChannelsService` mantém a sua cópia (unificar é refactor fora do escopo deste SI).
  - As transições (`transitionToProcessing`, `markReady`, `markError`, `markDraftError`) e `deleteDraft` devolvem o `affected` (number); `markReady` recebe `ReadyFields` (`duration_seconds`, `width`, `height`, `video_codec`, `container_format`, `bitrate_bps`, `metadata`). `markReady` usa um cast para `QueryDeepPartialEntity<Video>` porque o tipo do TypeORM não aceita objeto em coluna jsonb.
  - `markDraftError` não limpa `upload_id` (o plano não pede); o `findExpiredDrafts`/`findStaleProcessing` ordenam pelo prazo/início mais antigo primeiro.
  - `VideosModule` agora provê e exporta `VideosRepository` (além de `TypeOrmModule`).

### SI-03.7 — Exceções de domínio de vídeos e mapeamento no filtro existente
- **Status:** completed
- **Tests:** 9 novos passing em src/common/filters/domain-exception.filter.spec.ts (17 no diretório, via describe.each); tsc exit 0; lint exit 0
- **Observations:** 
  - Mensagens e códigos/status conforme o Error Catalog; nenhuma alteração no código do filtro.

### SI-03.8 — ChannelsService: resolver o canal do usuário autenticado
- **Status:** completed
- **Tests:** 4 novos passing (unit 2, integration 2) em src/channels; src/channels 29/29; tsc exit 0; lint exit 0
- **Observations:** 
  - Usa `dataSource.getRepository(Channel).findOneBy({ user_id })` para não alterar o construtor existente (per TD-11).

### SI-03.9 — Fila: QueueModule e produtor de jobs de processamento
- **Status:** completed
- **Tests:** 9 novos passing em src/queue/video-jobs.producer.integration-spec.ts (Redis real); tsc exit 0; lint exit 0
- **Observations:** 
  - **Desvio (infra de teste):** `@nestjs/bullmq@12.0.1` e `@nestjs/bull-shared` são ESM-only (`type: module`), contrariando a nota da library-refs de que não há dependência ESM-only; o Jest (CJS) falhava com `Unexpected token 'export'`. Solução: `transformIgnorePatterns` + transform ts-jest com `allowJs`/`module: commonjs` restritos a esses dois pacotes, em `package.json` (jest) e `test/jest-e2e.json`. Em runtime Node 25 o `require` de ESM funciona (`require('@nestjs/bullmq')` OK no container). Nenhuma TD alterada.
  - **jobId:** a doc do BullMQ (context7) e o teste real confirmam que ':' é rejeitado (`Custom Id cannot contain`); o hífen é aceito, então o id fica `process-video-{videoId}`.
  - `bullmq@6.7.1` sobe contra `ioredis@5.11.1` sem problemas. No bullmq 6 o `Queue` não expõe mais `.client` (há uma abstração `backend`); o teste verifica `opts.connection` (host `redis`, porta 6379), o prefixo e um round trip real (`getJobCounts`).
  - `jitter: 0.5` no backoff é o valor de exemplo da doc do BullMQ (o plano só cita `jitter`); constante `PROCESSING_BACKOFF_JITTER` com comentário `shortcut:`.
  - `QueueModule` ainda não é importado por `AppModule`/`VideosModule` (o plano o liga no SI-03.12, quando `VideosService` precisar do produtor). O worker temporário dos testes (failed/completed) é criado só no spec.

### SI-03.10 — Iniciar upload: planejador de partes e VideosService.initiateUpload
- **Status:** completed
- **Tests:** 16 novos passing (upload-part-planner.spec 5, videos.service.spec 6, videos.service.integration-spec 5 com DB e storage reais); src/videos 40/40; e2e 52/52; tsc exit 0; lint exit 0
- **Observations:** 
  - `VideosModule` passou a importar `StorageModule` e `ChannelsModule`; por isso `videos.module.spec.ts` e `videos.repository.integration-spec.ts` ganharam `ConfigModule.forRoot({ isGlobal, load: [storageConfig, uploadConfig] })` (consequência direta, sem mudança de comportamento).
  - O multipart é aberto com a chave `videoOriginalKey(video.id)` (uuid interno); a resposta expõe `public_id` como `id`. A ordem de validação é content-type, tamanho, canal, para não consultar o banco em requisições inválidas.
  - A compensação (`deleteDraft`) cobre `createMultipartUpload` e `setUploadId`; se `setUploadId` falhar depois do multipart aberto, o multipart fica órfão no storage (sem rascunho para o sweeper); risco raro, não tratado neste SI.
  - O teste de integração verifica o multipart aberto de verdade com `listParts` (vazio) no bucket de teste dedicado; a falha do storage é simulada com `jest.spyOn` sobre o `StorageService` real para validar a remoção real da linha.

### SI-03.11 — VideosService: URLs por parte e listagem de partes (retomada)
- **Status:** completed
- **Tests:** 15 novos passing (unit 10 em videos.service.spec, integration 5 em videos.service.integration-spec com DB e storage reais); src/videos 55/55; tsc exit 0; lint exit 0
- **Observations:**
  - DTOs: `PartUrlsDto` (validação com `@ArrayNotEmpty`/`@ArrayMaxSize(MAX_PARTS)`/`@IsInt({ each })`/`@Min(1, { each })`, conferido no context7 `/typestack/class-validator`), `PartUrlsResponseDto` e `UploadedPartsResponseDto` (com DTOs aninhados `PartUrlDto`/`UploadedPartDto`) em arquivos separados, por convenção de um DTO principal por arquivo.
  - `VideosService` ganhou a injeção de `storageConfig.KEY` (para `expires_in = presignExpiresSeconds`); o spec de integração passou a sobrescrever `uploadConfig.KEY` com um objeto mutável para usar partes de 5 MiB só nos testes de partes reais (o teste de 10 GiB / 160 partes do SI-03.10 segue com 64 MiB).
  - `getOwnedDraft(userId, publicId, { requireValid })`: `requireValid = false` será usado pelo `abortUpload` (SI-03.12). Um rascunho com `upload_expires_at` nulo é tratado como expirado.
  - Os números de parte são deduplicados e devolvidos em ordem crescente.

### SI-03.12 — VideosService: completar (HeadObject, transição e enqueue) e abortar upload
- **Status:** completed
- **Tests:** 25 novos passing (unit 16 em videos.service.spec, integration 9 em videos.service.integration-spec com DB, storage e Redis reais); src/videos 80/80; tsc exit 0; lint exit 0
- **Observations:**
  - `VideosModule` agora importa `QueueModule`; por isso `videos.repository.integration-spec.ts` ganhou `redisConfig` no `ConfigModule` e `videos.module.spec.ts` substitui o `QueueModule` por um módulo falso via `overrideModule` (o spec é unit e não deve abrir conexão com o Redis); o spec de integração do serviço usa prefixo de fila único (`uniqueQueuePrefix`) e `obliterate` das filas.
  - **Risco do SI-03.10 tratado:** se `setUploadId` falhar depois de o multipart abrir, o `initiateUpload` agora faz um abort de melhor esforço (falha do abort só vira log `warn` e não mascara o erro original) antes de `deleteDraft`; coberto por 2 unit e 1 integration (contagem de multiparts abertos antes/depois). Alteração mínima no código do SI-03.10, registrada aqui.
  - O erro do storage para ETag errada na engine silo chega com `name = 'InvalidPart'` e é mapeado para `InvalidUploadPartsException` (verificado com o storage real). `completeUpload` também limita `parts` a `MAX_PARTS` itens (`@ArrayMaxSize`), além do "não vazio" do plano, pelo teto de 10000 partes do S3.
  - `completeUpload` busca o vídeo de novo (`findById`) após a transição guardada para responder com `updated_at` real; o `abortUpload` lança `VideoNotInDraftException` se `deleteDraft` afetar 0 linhas (complete concorrente).
  - No mismatch de tamanho o objeto já completo permanece no storage (o plano só pede `markDraftError`); a limpeza de objetos de vídeos em `error` não está definida na fase: ponto de atenção fora do escopo.
  - `completeUpload` concorrente com outro `complete` pode receber `NoSuchUpload` do storage e responder `INVALID_UPLOAD_PARTS` (400) em vez de 409; comportamento decorrente do mapeamento exigido pelo plano.

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
