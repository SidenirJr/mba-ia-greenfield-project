---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-05T17:46:44-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-05T17:46:44-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-05T17:46:44-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-11-05T17:15:29-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-05T17:15:29-03:00"
  docs/project-plan.md: "2026-11-05T17:15:29-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video ingestion backend in `nestjs-project`: S3-compatible object storage and a Redis-backed job queue in Docker Compose, direct-to-storage multipart upload of files up to 10 GiB with per-part presigned URLs (resumable, API never carries the bytes), automatic draft pre-registration, background processing by an FFmpeg worker (duration/metadata via ffprobe + thumbnail), a unique short public id per video, and streaming/download delivery via redirect to presigned URLs.

---

## Step Implementations

### SI-03.1 — Spike: storage S3-compatível (pgsty/silo + pgsty/mc) no Compose e contrato S3

**Description:** Subir o serviço de object storage e o init de bucket no Compose e provar com um spec de contrato real que a engine escolhida suporta tudo que a fase usa (multipart, presign, ListParts, Range, CORS com `ETag`, healthcheck), antes de qualquer código de aplicação depender dela — a imagem `pgsty/silo` não foi validada.

**Technical actions:**

1. Adicionar o serviço `minio` ao `nestjs-project/compose.yaml` — imagem `pgsty/silo`, `command: server /data --console-address ":9001"`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` vindos de `${S3_ACCESS_KEY_ID}`/`${S3_SECRET_ACCESS_KEY}`, volume nomeado para `/data`, portas `9000:9000` e `9001:9001` publicadas, healthcheck (`curl -f http://localhost:9000/minio/health/live` se a imagem tiver `curl`; senão `mc ready local` ou equivalente comprovado no spike) (per `phase-03-videos/TD-13`, `TD-10`). _Nome de serviço `minio` (alinhado ao texto das TD-03/TD-10, embora a imagem seja o fork silo): parâmetro de implementação — sem TD._
2. Adicionar o serviço one-shot `minio-init` — imagem `pgsty/mc`, `depends_on: minio: condition: service_healthy`, `restart: "no"`, script que roda `mc alias set`, `mc mb --ignore-existing local/${S3_BUCKET}` e aplica CORS pelo mecanismo suportado pela engine (variável global `MINIO_API_CORS_ALLOW_ORIGIN` reportada na TD-03, ou CORS de bucket via `mc`), com `ETag` exposto; adicionar `minio-init: condition: service_completed_successfully` ao `depends_on` de `nestjs-api` (per `phase-03-videos/TD-10`, `TD-03`)
3. Acrescentar ao `nestjs-project/.env.example` (e ao `.env` local, não versionado) `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `S3_REGION=us-east-1`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET=streamtube`, `S3_FORCE_PATH_STYLE=true` (per `phase-03-videos/TD-03`); não alterar o `MAIL_FROM` existente (fora de escopo)
4. Instalar `@aws-sdk/client-s3@^3.1163.0` e `@aws-sdk/s3-request-presigner@^3.1163.0` em `nestjs-project` (per `phase-03-videos/TD-02`)
5. Criar `src/storage/storage-engine.integration-spec.ts` — spec de contrato com clientes S3 crus (sem código de aplicação): multipart em 2 partes via URLs pré-assinadas enviadas com `node:http` `request()` sobrescrevendo o header `host` para o host público (não `fetch`), `ListParts`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `GET` com `Range`, `ResponseContentDisposition`, preflight CORS com `Origin`; registrar os achados (healthcheck escolhido, mecanismo de CORS, checksums) em `Observations` do `progress.md` (per `phase-03-videos/TD-12`, `TD-13`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `pgsty/silo` + `pgsty/mc` (contrato S3) | Integration: multipart + presign + ListParts + Range + CORS ETag contra o serviço real | `src/storage/storage-engine.integration-spec.ts` |

**Dependencies:** none _(pré-requisito externo, fora desta fase: branch `bugfix` separada com o baseline de lint e a correção de `migrations.integration-spec.ts`, mesclada antes de iniciar a fase)_

**Acceptance criteria:**

- `docker compose up -d minio minio-init` deixa `minio` com status `healthy` e `minio-init` com exit code 0; rodar `minio-init` uma segunda vez também termina com exit code 0 (idempotente)
- O bucket `streamtube` existe após o init e as portas `9000` e `9001` do host respondem; nenhuma porta de Redis é publicada
- Upload multipart de 2 partes (5 MiB + resto) por URLs `UploadPart` pré-assinadas para o host público, enviadas ao serviço `minio:9000` com `host` sobrescrito, completa e `HeadObject` retorna o tamanho total
- `ListParts` de um upload em andamento retorna as partes enviadas com seus `ETag`; após `AbortMultipartUpload` o upload não aparece mais
- `GET` na URL pré-assinada com `Range: bytes=0-99` retorna `206` com `Content-Range` e `Accept-Ranges`
- `GET` na URL pré-assinada com `ResponseContentDisposition` retorna o header `Content-Disposition: attachment; filename=...`
- Preflight `OPTIONS` com `Origin` retorna `Access-Control-Allow-Origin` e `Access-Control-Expose-Headers` contendo `ETag`
- Se qualquer critério de multipart/presign/`ListParts`/Range falhar na engine, o SI termina em falha e a decisão é reaberta via `/decide` (TD-13) — o plano não troca de engine silenciosamente

---

### SI-03.2 — Infra: ffmpeg no Dockerfile.dev e serviço Redis no Compose

**Description:** Disponibilizar `ffmpeg`/`ffprobe` na imagem `nestjs-api` (usada também pelo worker e pelos testes de integração) e subir o Redis da fila, sem publicar porta, com política de memória e persistência exigidas pelo BullMQ.

**Technical actions:**

1. Editar `nestjs-project/Dockerfile.dev` — acrescentar `ffmpeg` ao `apt install` existente (`procps curl ffmpeg`), executado como root **antes** de `USER node` (a imagem atual é `node:25.6.0-slim` sem ffmpeg) (per `phase-03-videos/TD-05`, `TD-06`)
2. Adicionar o serviço `redis` ao `compose.yaml` — imagem `redis:7-alpine` _(tag: parâmetro de implementação — sem TD; confirmar existência da tag no pull)_, `command: redis-server --maxmemory-policy noeviction --appendonly yes`, volume nomeado para `/data`, **sem `ports`** (a porta 6379 do host está ocupada), healthcheck `redis-cli ping` (per `phase-03-videos/TD-01`, `TD-10`)
3. Adicionar `redis: condition: service_healthy` ao `depends_on` de `nestjs-api` (per `phase-03-videos/TD-10`)
4. Acrescentar ao `.env.example` (e ao `.env` local) `REDIS_HOST=redis` e `REDIS_PORT=6379` (per `phase-03-videos/TD-01`)
5. Rebuild da imagem (`docker compose build nestjs-api`) e recriação dos serviços; validar `ffmpeg`/`ffprobe` e o Redis dentro do Compose

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose exec nestjs-api ffmpeg -version` e `docker compose exec nestjs-api ffprobe -version` terminam com exit code 0, executando como usuário `node`
- `docker compose ps` mostra `redis` com status `healthy` e sem nenhuma porta publicada no host
- `docker compose exec redis redis-cli config get maxmemory-policy` retorna `noeviction` e `config get appendonly` retorna `yes`
- `docker compose exec nestjs-api` consegue conectar em `redis:6379` pelo nome do serviço (`PING` retorna `PONG`)

---

### SI-03.3 — Dependências de fila, namespaces de configuração e validação Joi

**Description:** Instalar as bibliotecas de fila, criar os namespaces `registerAs` de storage, redis, upload e worker e estender o schema Joi, seguindo o padrão da Fase 01, para que os módulos seguintes consumam config tipada.

**Technical actions:**

1. Instalar `bullmq@^6.7.0`, `@nestjs/bullmq@^12.0.0` e `ioredis@^5.11.1` em `nestjs-project` (per `phase-03-videos/TD-01`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` (per `phase-03-videos/TD-03`) e `PRESIGN_EXPIRES_SECONDS` (default `900`, valor padrão do SDK — _parâmetro de implementação — sem TD; default proposto_)
3. Criar `src/config/redis.config.ts` — `registerAs('redis', ...)` com `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`) (per `phase-03-videos/TD-01`) e `QUEUE_PREFIX` (default `streamtube`; isolamento de testes por prefixo, per `phase-03-videos/TD-12` — _nome da env: parâmetro de implementação — sem TD_)
4. Criar `src/config/upload.config.ts` — `registerAs('upload', ...)` com `UPLOAD_MAX_BYTES` (default `10737418240` = 10 GiB), `UPLOAD_PART_SIZE_BYTES` (default `67108864` = 64 MiB) (per `phase-03-videos/TD-02`) e `UPLOAD_EXPIRATION_HOURS` (default `24`, alinhado ao `stale_uploads_expiry` ~24h citado na TD-02 — _parâmetro de implementação — sem TD; default proposto_); criar `src/config/worker.config.ts` — `registerAs('worker', ...)` com `SWEEPER_INTERVAL_MS` (default `300000`), `PROCESSING_STALE_MS` (default `3600000`), `FFMPEG_TIMEOUT_MS` (default `600000`) — _os três: parâmetros de implementação — sem TD; defaults propostos (TD-09/TD-06 pedem "threshold" e "timeout-bounded" sem valor)_
5. Estender `src/config/env.validation.ts` (Joi: `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` obrigatórios; demais com default; `UPLOAD_*`/`*_MS` numéricos positivos; `S3_FORCE_PATH_STYLE` `true|false`), registrar os quatro namespaces em `ConfigModule.forRoot({ load })` do `AppModule` e completar o `.env.example` com `QUEUE_PREFIX`, `UPLOAD_*`, `PRESIGN_EXPIRES_SECONDS`, `SWEEPER_INTERVAL_MS`, `PROCESSING_STALE_MS`, `FFMPEG_TIMEOUT_MS`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (variáveis de storage, redis, upload, worker) | Integration: defaults, obrigatórias ausentes, valores inválidos (existing file extended) | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1 (variáveis `S3_*`), SI-03.2 (variáveis `REDIS_*`)

**Acceptance criteria:**

- Iniciar a aplicação sem `S3_ACCESS_KEY_ID` (ou `S3_SECRET_ACCESS_KEY`, ou `S3_BUCKET`) falha na validação Joi no bootstrap
- Com apenas as variáveis obrigatórias, `UPLOAD_MAX_BYTES` resolve para `10737418240` e `UPLOAD_PART_SIZE_BYTES` para `67108864`
- `UPLOAD_MAX_BYTES=0` ou `SWEEPER_INTERVAL_MS=abc` é rejeitado pelo schema com mensagem citando a variável
- `GET /` continua retornando `200` com o `.env` atualizado (e2e existente `app.e2e-spec.ts`)

---

### SI-03.4 — StorageModule: clientes S3 (interno + presign) e StorageService

**Description:** Encapsular todo acesso ao object storage em um módulo próprio, com um cliente interno (`S3_ENDPOINT`) e um cliente exclusivo de presign (`S3_PUBLIC_ENDPOINT`), expondo apenas a API S3 padrão (sem recursos específicos de engine).

**Technical actions:**

1. Criar `src/storage/storage.constants.ts` — tokens de injeção `S3_CLIENT` e `S3_PRESIGN_CLIENT`, funções de chave `videoOriginalKey(id)` → `videos/{id}/original` e `videoThumbnailKey(id)` → `videos/{id}/thumbnail.jpg` (per `phase-03-videos/TD-10`)
2. Criar `src/storage/storage.module.ts` — providers dos dois `S3Client` via `inject: [storageConfig.KEY]`: interno com `endpoint = S3_ENDPOINT`, `forcePathStyle`, credenciais e checksums conforme os achados do SI-03.1; presign com `endpoint = S3_PUBLIC_ENDPOINT`, `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-03`); exportar `StorageService`
3. Criar `src/storage/storage.service.ts` — `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber)` (cliente de presign), `listParts(key, uploadId)` (todas as páginas via `PartNumberMarker`), `completeMultipartUpload`, `abortMultipartUpload` (tolera `NoSuchUpload`), `headObject`, `putObject`, `presignGetObject(key, { responseContentType, responseContentDisposition })` (cliente de presign, `S3_PUBLIC_ENDPOINT`) e `presignInternalGetObject(key, expiresIn)` (cliente interno, para ffprobe/ffmpeg) (per `phase-03-videos/TD-02`, `TD-03`, `TD-06`, `TD-08`); nunca usar `@aws-sdk/lib-storage` `Upload` na API
4. Criar helpers de teste `src/test/storage-test.ts` — cria/remove um bucket de teste dedicado por execução (`CreateBucket` idempotente, per `phase-03-videos/TD-12`, `TD-10`) e `requestPresignedUrl(url, { method, body, publicHost, range })` baseado em `node:http` `request()` com `host` sobrescrito (não `fetch`, per `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` (URL de presign) | Unit: lib real com config de teste — host de `S3_PUBLIC_ENDPOINT`, `X-Amz-Signature`, expiração, `partNumber`/`uploadId`, `response-content-disposition`; paginação de `listParts` com cliente S3 mockado | `src/storage/storage.service.spec.ts` |
| `StorageService` | Integration: multipart real com 2 partes via URL pré-assinada + host override, `listParts`, `headObject`, `putObject`, `abort` tolerante, URL interna usada diretamente | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo com `ConfigModule` global — dois clientes distintos | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (engine validada, achados de checksum/CORS), SI-03.3 (config `storage`)

**Acceptance criteria:**

- `presignUploadPart` devolve uma URL cujo host é o de `S3_PUBLIC_ENDPOINT`, com `X-Amz-Signature`, `X-Amz-Expires` igual a `PRESIGN_EXPIRES_SECONDS`, `partNumber` e `uploadId`
- Uma URL de parte assinada para o host público, enviada ao `S3_ENDPOINT` com o header `host` sobrescrito, é aceita pelo storage e retorna `ETag`
- `listParts` retorna todas as partes de um upload mesmo quando há mais de uma página
- `abortMultipartUpload` de um upload inexistente não lança erro
- `presignInternalGetObject` devolve uma URL com host `S3_ENDPOINT` que responde `200` ao ser acessada diretamente de dentro do container

---

### SI-03.5 — Entidade Video, migration CreateVideos e VideosModule base

**Description:** Persistir o vídeo ligado ao canal (`channels` 1:1 com `users`) com o ciclo de status e as colunas de upload/metadados, criar a migration pelo CLI do TypeORM e o `VideosModule` que é dono da entidade.

**Technical actions:**

1. Criar `src/videos/videos.constants.ts` (`VideoStatus` = `draft | processing | ready | error`, `as const`) e `src/videos/entities/video.entity.ts` — `@Entity('videos')` com as colunas, constraints e índices do `### Data Model → Video`; propriedades em `snake_case` como `Channel`; `bigint` com transformer string ⇄ number; `@ManyToOne(() => Channel, (c) => c.videos)` + `@JoinColumn({ name: 'channel_id' })` (per `phase-03-videos/TD-07`, `TD-09`, `TD-11`)
2. Adicionar o lado inverso `@OneToMany(() => Video, (v) => v.channel) videos: Video[]` em `src/channels/entities/channel.entity.ts` (regra de relações bidirecionais; sem mudança de schema em `channels`)
3. Gerar a migration `CreateVideos` pelo CLI (`npm run migration:generate`) em `src/database/migrations/`, revisar o SQL (enum `video_status`, FK `channel_id`, unique `public_id`) e aplicá-la contra o banco limpo (`npm run migration:run`) (per `typeorm-migrations` rule)
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e importar `VideosModule` no `AppModule`; estender `cleanAllTables` em `src/test/create-test-data-source.ts` para apagar `videos` **antes** de `channels`
5. Estender (consequência direta de adicionar a migration, não a correção pré-existente do spec) `src/database/migrations.integration-spec.ts`: acrescentar `Video`, `CreateVideos…` à lista explícita de migrations, `videos` a `MANAGED_TABLES`, ajustar a contagem de migrations aplicadas e o teste de `undoLastMigration` (a última migration agora remove `videos`, não as tabelas de token); `afterAll` continua re-aplicando todas as migrations

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique `public_id`, default `status = 'draft'`, FK `channel_id`, enum inválido rejeitado, colunas nullable de metadados, `bigint` ⇄ number | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Unit: compilação do módulo (repositório mockado) | `src/videos/videos.module.spec.ts` |
| Migrations (`CreateVideos`) | Integration: aplicar e reverter com a lista incluindo a nova migration (existing file extended) | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Após `migration:run` em banco limpo existe a tabela `videos` com a coluna `public_id` única e FK para `channels(id)`
- Inserir dois vídeos com o mesmo `public_id` viola a constraint unique (`23505`)
- Um vídeo inserido sem `status` fica com `status = 'draft'`; um valor fora do enum é rejeitado pelo banco
- Reverter a migration `CreateVideos` remove a tabela `videos` e o tipo `video_status`; reaplicar a recria
- `cleanAllTables` remove vídeos sem violar a FK de `channels`

---

### SI-03.6 — Id público base62 e VideosRepository (unicidade e transições guardadas)

**Description:** Gerar o id público curto e único (11 chars base62) sem dependência externa e centralizar no repositório a criação do rascunho com retry de unicidade e as transições de status guardadas (`UPDATE … WHERE status = …`) que sustentam a idempotência.

**Technical actions:**

1. Criar `src/videos/video-public-id.util.ts` — `generateVideoPublicId()` com `crypto.randomInt(62)` por caractere sobre `[0-9A-Za-z]`, 11 caracteres, sem `-`/`_` (per `phase-03-videos/TD-07`)
2. Criar `src/videos/videos.repository.ts` — classe `@Injectable` que injeta `Repository<Video>`: `createDraft(data)` com `MAX_RETRIES = 5` regenerando o `public_id` ao capturar `23505` na coluna `public_id` (mesmo padrão de `ChannelsService`; per `phase-03-videos/TD-07`), `findByPublicId`, `findOwnedByPublicId(publicId, channelId)`, `findById`, `setUploadId`, `deleteDraft(id)` (apenas `status = 'draft'`) (per `phase-03-videos/TD-02`, `TD-11`)
3. Em `videos.repository.ts`, adicionar as transições guardadas via `createQueryBuilder().update()` retornando `affected`: `transitionToProcessing(id, now)` (`draft → processing`, limpa `upload_id`/`upload_expires_at`, grava `processing_started_at`), `markReady(id, fields)` e `markError(id, code, message)` (`processing → ready|error`), `markDraftError(id, code, message)` (`draft → error`, usado no `UPLOAD_SIZE_MISMATCH`) (per `phase-03-videos/TD-04`, `TD-09`)
4. Em `videos.repository.ts`, adicionar as consultas do sweeper `findExpiredDrafts(now, limit)` e `findStaleProcessing(olderThan, limit)`; registrar `VideosRepository` como provider (exportado) em `VideosModule` (per `phase-03-videos/TD-09`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateVideoPublicId` | Unit: 11 chars, alfabeto `[0-9A-Za-z]`, distribuição sem `-`/`_`, valores distintos em N chamadas | `src/videos/video-public-id.util.spec.ts` |
| `VideosRepository` | Integration: retry de colisão de `public_id` (gerador forçado a colidir), transições guardadas (`affected` 1 vs 0), `deleteDraft` só em draft, consultas do sweeper | `src/videos/videos.repository.integration-spec.ts` |

**Dependencies:** SI-03.5 (entidade e tabela)

**Acceptance criteria:**

- `createDraft` retorna um vídeo com `status = 'draft'` e `public_id` de 11 caracteres alfanuméricos
- Quando o primeiro `public_id` gerado já existe, `createDraft` regenera e persiste com outro valor; após 5 colisões consecutivas propaga o erro
- `transitionToProcessing` aplicado duas vezes ao mesmo vídeo afeta 1 linha na primeira chamada e 0 na segunda
- `markReady` e `markError` só afetam vídeos em `processing`; num vídeo já `ready` afetam 0 linhas
- `findExpiredDrafts` retorna apenas rascunhos com `upload_expires_at` vencido; `findStaleProcessing` retorna apenas `processing` com `processing_started_at` anterior ao limite

---

### SI-03.7 — Exceções de domínio de vídeos e mapeamento no filtro existente

**Description:** Declarar as exceções de domínio do módulo de vídeos como subclasses de `DomainException`, que o `DomainExceptionFilter` existente já mapeia genericamente para o envelope `{ statusCode, error, message }`.

**Technical actions:**

1. Estender `src/common/exceptions/domain.exception.ts` (arquivo que já concentra as exceções de domínio) com as subclasses do `### Error Catalog`: `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`), `ChannelNotFoundException` (404 `CHANNEL_NOT_FOUND`), `InvalidContentTypeException` (415 `INVALID_CONTENT_TYPE`), `UploadSizeExceedsLimitException` (413 `UPLOAD_SIZE_EXCEEDS_LIMIT`), `VideoNotInDraftException` (409 `VIDEO_NOT_IN_DRAFT`), `UploadExpiredException` (410 `UPLOAD_EXPIRED`), `InvalidPartNumberException` (400 `INVALID_PART_NUMBER`), `InvalidUploadPartsException` (400 `INVALID_UPLOAD_PARTS`), `UploadSizeMismatchException` (409 `UPLOAD_SIZE_MISMATCH`) — mensagens em inglês como as da Fase 02; códigos/status são parâmetros de implementação (per `phase-02-auth/TD-07`)
2. Estender `src/common/filters/domain-exception.filter.spec.ts` para cobrir cada nova exceção; nenhuma alteração no código do filtro (ele usa `httpStatus` e `errorCode` da exceção)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `DomainExceptionFilter` + exceções de vídeo | Unit: cada exceção resulta em `{ statusCode, error, message }` com o código e status do catálogo (existing file extended) | `src/common/filters/domain-exception.filter.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Lançar cada nova exceção num handler é respondido com o `statusCode` e o `error` exatos do `### Error Catalog` (por exemplo `VideoNotFoundException` → `404` com `error: "VIDEO_NOT_FOUND"`)
- O corpo de toda resposta de erro de vídeo contém exatamente `statusCode`, `error` e `message`

---

### SI-03.8 — ChannelsService: resolver o canal do usuário autenticado

**Description:** Dar ao `ChannelsModule` a consulta de canal por usuário que o módulo de vídeos usa para autorização (a entidade `Channel` e suas consultas pertencem ao `ChannelsModule`, não ao `VideosModule`).

**Technical actions:**

1. Adicionar `getByUserId(userId: string): Promise<Channel>` em `src/channels/channels.service.ts` — busca por `channels.user_id` (unique, indexado) e lança `ChannelNotFoundException` quando não há canal; sem alterar o construtor existente (per `phase-03-videos/TD-11`)
2. Estender `src/channels/channels.service.spec.ts` e `src/channels/channels.service.integration-spec.ts` com os cenários de `getByUserId`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ChannelsService.getByUserId` | Unit: ramo encontrado / `ChannelNotFoundException` (existing file extended) | `src/channels/channels.service.spec.ts` |
| `ChannelsService.getByUserId` | Integration: consulta real por `user_id` (existing file extended) | `src/channels/channels.service.integration-spec.ts` |

**Dependencies:** SI-03.7 (`ChannelNotFoundException`)

**Acceptance criteria:**

- `getByUserId` de um usuário registrado retorna o canal cujo `user_id` é o informado
- `getByUserId` de um `userId` sem canal lança `ChannelNotFoundException` (`404 CHANNEL_NOT_FOUND`)

---

### SI-03.9 — Fila: QueueModule e produtor de jobs de processamento

**Description:** Registrar a conexão BullMQ com o Redis do Compose e as duas filas, expondo apenas o lado produtor (sem `@Processor`) e um produtor que garante idempotência por `jobId` determinístico; valida que `bullmq@6.7.0` sobe contra o `ioredis` instalado.

**Technical actions:**

1. Criar `src/queue/queue.constants.ts` — nomes das filas `video-processing` e `video-maintenance` (_duas filas: parâmetro de implementação — sem TD_), nomes de job `video.process` e `video.sweep`, id do scheduler `video-sweeper` e `processVideoJobId(videoId)` → `process-video-{videoId}` (per `phase-03-videos/TD-04`)
2. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` com `inject: [redisConfig.KEY]` (`connection: { host, port }`, `prefix: QUEUE_PREFIX`) e `BullModule.registerQueue` das duas filas, com `defaultJobOptions` de `video-processing`: `attempts: 3`, `backoff: { type: 'exponential', delay: 30000, jitter }`; exportar `BullModule` e `VideoJobsProducer`; **nenhum `@Processor`** neste módulo (per `phase-03-videos/TD-01`, `TD-05`, `TD-09`)
3. Criar `src/queue/video-jobs.producer.ts` — `enqueueProcessing(videoId)` (`queue.add('video.process', { videoId }, { jobId })`) e `ensureProcessingJob(videoId)` (se existe job vivo — waiting/active/delayed — não faz nada; se o registro é `failed`/`completed`, remove e re-adiciona, pois o `jobId` fixo bloquearia o novo `add`) (per `phase-03-videos/TD-04`)
4. Criar helper de teste `src/test/queue-test.ts` — prefixo único por execução e `obliterate` das filas no `beforeEach`/`afterAll` (per `phase-03-videos/TD-12`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` + `VideoJobsProducer` | Integration: Redis real — compilação/boot do `bullmq` com o `ioredis` instalado, aceitação do `jobId` com hífen (verificar também se `:` é aceito), opções `attempts`/`backoff`, `add` duplicado não cria 2º job, `ensureProcessingJob` (vivo vs. `failed`/`completed`) | `src/queue/video-jobs.producer.integration-spec.ts` |

**Dependencies:** SI-03.2 (Redis), SI-03.3 (`redis.config`, bibliotecas)

**Acceptance criteria:**

- `enqueueProcessing('<uuid>')` cria um job com `id = process-video-<uuid>`, `attempts = 3` e backoff exponencial de 30000 ms
- Chamar `enqueueProcessing` duas vezes para o mesmo vídeo mantém um único job na fila
- `ensureProcessingJob` não duplica um job `waiting`; para um job `failed` do mesmo vídeo cria um novo job aguardando processamento
- O módulo conecta em `redis:6379` pelo nome do serviço usando o prefixo configurado em `QUEUE_PREFIX`
- Subir apenas o `AppModule` não inicia nenhum consumidor da fila `video-processing`

---

### SI-03.10 — Iniciar upload: planejador de partes e VideosService.initiateUpload

**Description:** Calcular o plano de partes multipart, pré-cadastrar o vídeo como rascunho sob o canal do chamador e iniciar o multipart no storage, devolvendo o `part_size` que o cliente deve usar.

**Technical actions:**

1. Criar `src/videos/upload-part-planner.ts` — `planUploadParts(sizeBytes, configuredPartSize)` → `{ partSize, partCount }` com `partSize = max(configured, 5 MiB, ceil(size / 10000))` e `partCount = ceil(size / partSize)`; constantes `MIN_PART_SIZE` (5 MiB) e `MAX_PARTS` (10000) em `videos.constants.ts` (per `phase-03-videos/TD-02`)
2. Criar `src/videos/dto/initiate-upload.dto.ts` (`file_name`, `size_bytes`, `content_type`, só `class-validator`, sem `@ApiProperty` manual) e `src/videos/dto/initiate-upload-response.dto.ts` (response DTO com `@ApiProperty`: `id`, `status`, `part_size`, `part_count`, `expires_at`)
3. Criar `src/videos/videos.service.ts` com `initiateUpload(userId, dto)`: valida prefixo `video/` (`InvalidContentTypeException`) e `size_bytes ≤ UPLOAD_MAX_BYTES` (`UploadSizeExceedsLimitException`); resolve o canal via `ChannelsService.getByUserId`; `createDraft` com `upload_expires_at = now + UPLOAD_EXPIRATION_HOURS`; `StorageService.createMultipartUpload(videoOriginalKey(id), content_type)`; `setUploadId`; em falha do storage apaga o rascunho (`deleteDraft`) e relança o erro (per `phase-03-videos/TD-02`, `TD-09`, `TD-11`, `TD-15`)
4. Em `videos.module.ts`, importar `StorageModule`, `ChannelsModule` e registrar `VideosService` como provider/exportado

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `planUploadParts` | Unit: 10 GiB com 64 MiB → 160 partes, piso de 5 MiB, `ceil(size/10000)` dominante para tamanhos grandes, 1 byte → 1 parte, múltiplo exato | `src/videos/upload-part-planner.spec.ts` |
| `VideosService.initiateUpload` | Unit: 415, 413, canal ausente, compensação (apaga rascunho) quando o storage falha (repo/storage mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: DB + storage reais — rascunho criado com `upload_id` e `upload_expires_at`, multipart realmente aberto | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 (StorageService), SI-03.6 (repositório), SI-03.7 (exceções), SI-03.8 (canal do usuário)

**Acceptance criteria:**

- Iniciar upload de 10737418240 bytes com `UPLOAD_PART_SIZE_BYTES=67108864` devolve `part_size = 67108864` e `part_count = 160`
- Iniciar upload com `size_bytes` acima de `UPLOAD_MAX_BYTES` falha com `UploadSizeExceedsLimitException` e não cria linha em `videos`
- Iniciar upload com `content_type = 'application/pdf'` falha com `InvalidContentTypeException` e não cria linha em `videos`
- Após iniciar, existe um vídeo `draft` do canal do chamador com `upload_id` preenchido e `upload_expires_at` ≈ agora + 24h
- Quando `CreateMultipartUpload` falha, nenhuma linha de rascunho permanece em `videos`

---

### SI-03.11 — VideosService: URLs por parte e listagem de partes (retomada)

**Description:** Permitir ao dono reemitir URLs pré-assinadas de `UploadPart` e consultar as partes já gravadas (`ListParts`) para retomar um upload interrompido, com a checagem de propriedade/estado/validade em um único ponto.

**Technical actions:**

1. Criar `src/videos/dto/part-urls.dto.ts` (`part_numbers`: inteiros ≥ 1, não vazio, máx. 10000) e response DTOs `PartUrlsResponseDto` (`parts[{ part_number, url }]`, `expires_in`) e `UploadedPartsResponseDto` (`part_size`, `part_count`, `parts[{ part_number, size, etag }]`)
2. Em `videos.service.ts`, criar o método privado `getOwnedDraft(userId, publicId)` — resolve o canal, `findOwnedByPublicId` (ausente/alheio → `VideoNotFoundException`), exige `status = 'draft'` (`VideoNotInDraftException`) e `upload_expires_at` futuro (`UploadExpiredException`) (per `phase-03-videos/TD-11`, `TD-09`)
3. Adicionar `getPartUrls(userId, publicId, partNumbers)` — valida cada número `≤ part_count` (`InvalidPartNumberException`), remove duplicatas e assina `presignUploadPart` para cada um com `PRESIGN_EXPIRES_SECONDS` (per `phase-03-videos/TD-02`, `TD-03`)
4. Adicionar `listUploadedParts(userId, publicId)` — `StorageService.listParts` mapeado para `{ part_number, size, etag }` ordenado, junto de `part_size` e `part_count` (per `phase-03-videos/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPartUrls` / `listUploadedParts` | Unit: 404 alheio/inexistente, 409 fora de draft, 410 expirado, 400 número de parte fora do intervalo, deduplicação (mocks) (existing file extended) | `src/videos/videos.service.spec.ts` |
| `VideosService.getPartUrls` / `listUploadedParts` | Integration: URL de parte usada via host override, depois `listUploadedParts` retorna a parte; reemissão de URL da mesma parte (existing file extended) | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.10

**Acceptance criteria:**

- `getPartUrls` para `part_numbers [1, 2]` de um rascunho do chamador devolve duas URLs assinadas para o host público
- `getPartUrls` com `part_number` maior que `part_count` falha com `InvalidPartNumberException`
- Vídeo de outro canal ou inexistente resulta em `VideoNotFoundException` com a mesma resposta nos dois casos
- Vídeo que não está em `draft` falha com `VideoNotInDraftException`; rascunho com `upload_expires_at` no passado falha com `UploadExpiredException`
- Depois de enviar a parte 1 pela URL, `listUploadedParts` retorna a parte 1 com `size` e `etag` e as demais ausentes

---

### SI-03.12 — VideosService: completar (HeadObject, transição e enqueue) e abortar upload

**Description:** Finalizar o multipart, validar o tamanho do objeto, mover o vídeo para `processing` com update guardado e enfileirar o job; e permitir abortar o upload descartando o rascunho.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` (`parts[{ part_number, etag }]`, validação aninhada, não vazio) e `src/videos/dto/video-response.dto.ts` (response DTO com `@ApiProperty` — campos do `GET /videos/:id`, `null` quando ainda não processado)
2. Adicionar `completeUpload(userId, publicId, dto)` em `videos.service.ts`: `getOwnedDraft`; `CompleteMultipartUpload` (erros `InvalidPart`/`InvalidPartOrder`/`EntityTooSmall`/`NoSuchUpload` → `InvalidUploadPartsException`); `headObject` com `size ≠ size_bytes` → `markDraftError('UPLOAD_SIZE_MISMATCH')` + `UploadSizeMismatchException`; `transitionToProcessing` guardado (`affected = 0` → `VideoNotInDraftException`); `VideoJobsProducer.enqueueProcessing`; retornar o vídeo em `processing` (per `phase-03-videos/TD-04`, `TD-09`)
3. No `completeUpload`, tratar falha do enqueue registrando log e **sem** propagar — o estado `processing` é durável e o sweeper reenfileira (conversão intencional de erro em resultado de domínio, per `phase-03-videos/TD-04`; _decisão de tratamento: parâmetro de implementação — sem TD_)
4. Adicionar `abortUpload(userId, publicId)`: `getOwnedDraft` (sem exigir validade), `abortMultipartUpload` (tolera `NoSuchUpload`) e `deleteDraft` (per `phase-03-videos/TD-02`, `TD-09`); importar `QueueModule` em `videos.module.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` / `abortUpload` | Unit: conflito em repetição (`affected = 0`), mismatch → `error`, partes inválidas, falha de enqueue não propaga, abort tolera `NoSuchUpload` (mocks) (existing file extended) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` / `abortUpload` | Integration: upload real de 2 partes (≥ 5 MiB + resto) → `processing` + job `process-video-<uuid>` na fila; segundo `complete` → `VideoNotInDraftException`; abort remove linha e upload (existing file extended) | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.9 (produtor), SI-03.11 (`getOwnedDraft`)

**Acceptance criteria:**

- Completar um upload íntegro move o vídeo para `processing`, limpa `upload_id` e deixa exatamente um job `process-video-<uuid>` na fila `video-processing`
- Chamar `completeUpload` uma segunda vez para o mesmo vídeo falha com `VideoNotInDraftException` e não cria outro job
- Quando o objeto no storage tem tamanho diferente de `size_bytes`, o vídeo vira `error` com `error_code = 'UPLOAD_SIZE_MISMATCH'` e a chamada falha com `UploadSizeMismatchException`
- Lista de partes rejeitada pelo storage resulta em `InvalidUploadPartsException`
- Se o enqueue falhar, `completeUpload` ainda retorna o vídeo em `processing` e a falha é registrada em log
- `abortUpload` remove a linha do rascunho e o multipart deixa de existir no storage; abortar um vídeo já em `processing` falha com `VideoNotInDraftException`

---

### SI-03.13 — Endpoint POST /videos (iniciar upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-initiate-upload.plan.md`
**Authorization:** Authenticated

**Description:** Expor o início de upload (pré-cadastro do rascunho + multipart) criando o `VideosController` e documentando a rota em OpenAPI.

**Technical actions:**

1. Criar `src/videos/videos.controller.ts` — `@ApiTags('videos')`, `@Controller('videos')`, `@ApiBearerAuth('access-token')`; handler `POST /` com `@HttpCode(201)`, `@CurrentUser()` e `InitiateUploadDto`, delegando a `VideosService.initiateUpload` (per `phase-03-videos/TD-02`, `TD-11`; Tech Spec `### API Contracts → POST /videos`)
2. Documentar o handler com `@ApiOperation`, `@ApiResponse` 201 (`InitiateUploadResponseDto`) e um `@ApiResponse` por erro previsível (400, 401, 404, 413, 415) referenciando `ApiErrorEnvelope` via `getSchemaPath`
3. Registrar `VideosController` em `VideosModule` (rota protegida pelo `JwtAuthGuard` global — sem `@Public()`)

**Tests:** _(empty — controller wiring; E2E scenarios authored via /plan-test-specs spec)_

**Dependencies:** SI-03.10

**Acceptance criteria:**

- `POST /videos` com token válido e `{ file_name, size_bytes, content_type: "video/mp4" }` válidos retorna `201` com `id` de 11 caracteres, `status: "draft"`, `part_size`, `part_count` e `expires_at`
- `POST /videos` sem token retorna `401`
- `POST /videos` com `size_bytes` maior que `UPLOAD_MAX_BYTES` retorna `413` com `error: "UPLOAD_SIZE_EXCEEDS_LIMIT"`
- `POST /videos` com `content_type: "application/pdf"` retorna `415` com `error: "INVALID_CONTENT_TYPE"`
- `POST /videos` com corpo sem `file_name` ou com campo extra retorna `400` com `error: "VALIDATION_ERROR"`

---

### SI-03.14 — Endpoint POST /videos/:id/upload/part-urls

**Route:** POST /videos/:id/upload/part-urls
**Test Specs:** see `nestjs-project/specs/videos-part-urls.plan.md`
**Authorization:** Authenticated (owner)

**Description:** Expor a emissão/reemissão de URLs pré-assinadas por parte para o dono do vídeo.

**Technical actions:**

1. Adicionar ao `VideosController` o handler `POST :id/upload/part-urls` com `@HttpCode(200)`, `@Param('id')`, `@CurrentUser()` e `PartUrlsDto`, delegando a `VideosService.getPartUrls` (per `phase-03-videos/TD-02`; Tech Spec `### API Contracts → POST /videos/:id/upload/part-urls`)
2. Documentar com `@ApiOperation`, `@ApiParam`, `@ApiResponse` 200 (`PartUrlsResponseDto`) e erros 400, 401, 404, 409, 410 com `ApiErrorEnvelope`

**Tests:** _(empty — controller wiring; E2E scenarios authored via /plan-test-specs spec)_

**Dependencies:** SI-03.11, SI-03.13

**Acceptance criteria:**

- `POST /videos/:id/upload/part-urls` do dono com `{ part_numbers: [1, 2] }` retorna `200` com duas entradas `{ part_number, url }` e `expires_in`
- A mesma chamada por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `part_numbers` com valor maior que `part_count` retorna `400` com `error: "INVALID_PART_NUMBER"`; `part_numbers` vazio retorna `400` com `error: "VALIDATION_ERROR"`
- Para vídeo que já está em `processing` retorna `409` com `error: "VIDEO_NOT_IN_DRAFT"`; para rascunho expirado retorna `410` com `error: "UPLOAD_EXPIRED"`
- Sem token retorna `401`

---

### SI-03.15 — Endpoint GET /videos/:id/upload/parts (retomada)

**Route:** GET /videos/:id/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-list-parts.plan.md`
**Authorization:** Authenticated (owner)

**Description:** Expor a listagem das partes já gravadas para o cliente retomar um upload após falha de conexão.

**Technical actions:**

1. Adicionar ao `VideosController` o handler `GET :id/upload/parts` delegando a `VideosService.listUploadedParts` (per `phase-03-videos/TD-02`; origem `docs/project-plan.md` §4 "Pontos de Atenção"; Tech Spec `### API Contracts → GET /videos/:id/upload/parts`)
2. Documentar com `@ApiOperation`, `@ApiParam`, `@ApiResponse` 200 (`UploadedPartsResponseDto`) e erros 401, 404, 409, 410 com `ApiErrorEnvelope`

**Tests:** _(empty — controller wiring; E2E scenarios authored via /plan-test-specs spec)_

**Dependencies:** SI-03.11, SI-03.13

**Acceptance criteria:**

- Após enviar a parte 1 por uma URL obtida em `part-urls`, `GET /videos/:id/upload/parts` do dono retorna `200` com `part_size`, `part_count` e `parts` contendo `{ part_number: 1, size, etag }`
- Antes de qualquer parte enviada retorna `200` com `parts: []`
- Por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`
- Para vídeo fora de `draft` retorna `409`; para rascunho expirado retorna `410`
- Sem token retorna `401`

---

### SI-03.16 — Endpoint POST /videos/:id/upload/complete

**Route:** POST /videos/:id/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-complete-upload.plan.md`
**Authorization:** Authenticated (owner)

**Description:** Expor a finalização do upload, que dispara o processamento assíncrono do vídeo.

**Technical actions:**

1. Adicionar ao `VideosController` o handler `POST :id/upload/complete` com `@HttpCode(202)` e `CompleteUploadDto`, delegando a `VideosService.completeUpload` e respondendo com `VideoResponseDto` (per `phase-03-videos/TD-04`; Tech Spec `### API Contracts → POST /videos/:id/upload/complete`)
2. Documentar com `@ApiOperation`, `@ApiParam`, `@ApiResponse` 202 (`VideoResponseDto`) e erros 400, 401, 404, 409, 410 com `ApiErrorEnvelope`

**Tests:** _(empty — controller wiring; E2E scenarios authored via /plan-test-specs spec)_

**Dependencies:** SI-03.12, SI-03.13

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` do dono, com todas as partes e `etag` corretos, retorna `202` com `status: "processing"`
- Repetir a mesma chamada retorna `409` com `error: "VIDEO_NOT_IN_DRAFT"`
- Com `etag` incorreto numa parte retorna `400` com `error: "INVALID_UPLOAD_PARTS"`; com `parts` vazio retorna `400` com `error: "VALIDATION_ERROR"`
- Quando o tamanho enviado difere de `size_bytes` retorna `409` com `error: "UPLOAD_SIZE_MISMATCH"` e o vídeo passa a `status: "error"`
- Por outro usuário retorna `404`; rascunho expirado retorna `410`; sem token retorna `401`

---

### SI-03.17 — Endpoint DELETE /videos/:id/upload (abortar)

**Route:** DELETE /videos/:id/upload
**Test Specs:** see `nestjs-project/specs/videos-abort-upload.plan.md`
**Authorization:** Authenticated (owner)

**Description:** Expor o cancelamento de um upload em andamento, descartando o multipart e o rascunho.

**Technical actions:**

1. Adicionar ao `VideosController` o handler `DELETE :id/upload` com `@HttpCode(204)`, delegando a `VideosService.abortUpload` (per `phase-03-videos/TD-02`, `TD-09`; Tech Spec `### API Contracts → DELETE /videos/:id/upload`)
2. Documentar com `@ApiOperation`, `@ApiParam`, `@ApiResponse` 204 e erros 401, 404, 409 com `ApiErrorEnvelope`

**Tests:** _(empty — controller wiring; E2E scenarios authored via /plan-test-specs spec)_

**Dependencies:** SI-03.12, SI-03.13

**Acceptance criteria:**

- `DELETE /videos/:id/upload` do dono de um rascunho retorna `204` e `GET /videos/:id` passa a retornar `404`
- Por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"` e o rascunho permanece
- Para vídeo em `processing` retorna `409` com `error: "VIDEO_NOT_IN_DRAFT"`
- Sem token retorna `401`

---

### SI-03.18 — Endpoint GET /videos/:id (status do dono)

**Route:** GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-get-status.plan.md`
**Authorization:** Authenticated (owner)

**Description:** Permitir ao dono acompanhar o ciclo de status e os metadados do vídeo (rascunho → processando → pronto/erro).

**Technical actions:**

1. Adicionar `getOwnedVideo(userId, publicId)` em `videos.service.ts` — resolve o canal e `findOwnedByPublicId`; ausente/alheio → `VideoNotFoundException`; mapeia a entidade para `VideoResponseDto` (`id` = `public_id`, sem expor `upload_id`/`metadata`) (per `phase-03-videos/TD-11`)
2. Adicionar ao `VideosController` o handler `GET :id` delegando a `getOwnedVideo`, com `@ApiOperation`, `@ApiParam`, `@ApiResponse` 200 (`VideoResponseDto`) e erros 401, 404 com `ApiErrorEnvelope` (Tech Spec `### API Contracts → GET /videos/:id`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwnedVideo` | Unit: mapeamento do DTO (sem `upload_id`), 404 para inexistente/alheio (existing file extended) | `src/videos/videos.service.spec.ts` |
| `VideosService.getOwnedVideo` | Integration: leitura real filtrada por canal (existing file extended) | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6, SI-03.13

**Acceptance criteria:**

- `GET /videos/:id` do dono de um rascunho recém-criado retorna `200` com `status: "draft"` e metadados `null`
- Para um vídeo `ready` retorna `duration_seconds`, `width`, `height`, `video_codec`, `container_format` e `bitrate_bps` preenchidos
- Para um vídeo `error` retorna `error_code` e `error_message` preenchidos
- Por outro usuário autenticado ou para id inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"` (mesma resposta nos dois casos)
- Sem token retorna `401`; a resposta nunca contém `upload_id` nem `metadata`

---

### SI-03.19 — Helper de testes: fixtures de vídeo geradas com ffmpeg lavfi

**Description:** Gerar em tempo de teste os vídeos de exemplo (válido, não-faststart, ≥ 6 MiB, corrompido, só áudio) com `ffmpeg -f lavfi`, sem commitar binários, e validar de passagem que o ffmpeg da imagem funciona.

**Technical actions:**

1. Criar `src/test/video-fixtures.ts` — `generateSampleVideo({ durationSeconds, faststart, minBytes })` (usa `execFile('ffmpeg', ['-f','lavfi','-i','testsrc=…', …])` em diretório temporário), `generateMultipartVideo()` (≥ 6 MiB, para exercitar 2 partes de 5 MiB), `generateNonFaststartMp4()` (sem `-movflags +faststart`), `generateCorruptFile()`, `generateAudioOnlyFile()` e `cleanupFixtures()` (per `phase-03-videos/TD-12`, `TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `video-fixtures` | Integration: ffmpeg/ffprobe reais — arquivos gerados, ≥ 6 MiB, `moov` depois de `mdat` no não-faststart, corrompido ilegível, áudio-only sem stream de vídeo | `src/test/video-fixtures.integration-spec.ts` |

**Dependencies:** SI-03.2 (ffmpeg na imagem)

**Acceptance criteria:**

- `generateMultipartVideo()` produz um arquivo com tamanho ≥ 6 MiB legível por `ffprobe` com ao menos um stream de vídeo
- `generateNonFaststartMp4()` produz um MP4 em que o átomo `moov` aparece depois do `mdat`
- `generateCorruptFile()` produz um arquivo em que `ffprobe` termina com exit code ≠ 0
- `generateAudioOnlyFile()` produz um arquivo cujo `ffprobe` lista streams sem nenhum `codec_type = video`
- Nenhum binário de vídeo é versionado no repositório (`git status` limpo após a execução do spec)

---

### SI-03.20 — MediaToolsService: ffprobe e ffmpeg via child_process

**Description:** Encapsular a invocação direta de `ffprobe`/`ffmpeg` (sem `fluent-ffmpeg`, que está deprecado) lendo a entrada por URL HTTP pré-assinada interna, com timeout, mapeamento tipado do JSON e classificação de erros retryable vs. não-retryable.

**Technical actions:**

1. Criar `src/media/media.types.ts` e `src/media/media-probe.mapper.ts` — `MediaProbeResult` (`durationSeconds`, `width`, `height`, `videoCodec`, `containerFormat`, `bitrateBps`, `metadata`), mapeador do JSON do ffprobe (primeiro stream de vídeo; ausente → `NO_VIDEO_STREAM`), `metadata` aparado `{ format, streams[] }` com `format.filename` **removido** (contém a URL assinada) e `thumbnailSeekSeconds(duration)` = `min(max(0.1 × duration, 1), duration)` (per `phase-03-videos/TD-06`, `TD-14`)
2. Criar `src/media/media-processing.error.ts` — `MediaProcessingError` com `code` (`UNREADABLE_MEDIA`, `NO_VIDEO_STREAM`, `THUMBNAIL_FAILED`, `TRANSIENT`) e `retryable`; classificador de stderr/exit code/timeout (dados inválidos → não-retryable; I/O, conexão, HTTP 5xx, timeout → retryable) e sanitização que remove URLs assinadas das mensagens (per `phase-03-videos/TD-09`, `TD-15`)
3. Criar `src/media/media-tools.service.ts` — `probe(inputUrl)` (`ffprobe -v error -print_format json -show_format -show_streams <url>`) e `extractThumbnail(inputUrl, durationSeconds)` (`ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale='min(1280,iw)':-2 -q:v 3`, saída JPEG via stdout) usando `execFile` com `FFMPEG_TIMEOUT_MS` (per `phase-03-videos/TD-06`, `TD-14`)
4. Criar `src/media/media.module.ts` exportando `MediaToolsService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `media-probe.mapper` / classificador de erros | Unit: mapeamento do JSON, remoção de `format.filename`, `thumbnailSeekSeconds` (≥ 1s, ≤ duração, vídeo de 0,5s), classificação retryable/não-retryable, sanitização de URL | `src/media/media-probe.mapper.spec.ts` |
| `MediaToolsService` | Integration: ffprobe/ffmpeg reais com fixtures — válido, não-faststart lido por URL interna pré-assinada (Range), corrompido, áudio-only, timeout curto | `src/media/media-tools.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.4 (URL interna pré-assinada), SI-03.19 (fixtures)

**Acceptance criteria:**

- `probe` de um MP4 válido devolve `durationSeconds`, `width`, `height`, `videoCodec`, `containerFormat` e `bitrateBps` coerentes com o fixture
- `probe` de um MP4 não-faststart lido por URL interna pré-assinada devolve os mesmos metadados do arquivo local
- `probe` de um arquivo corrompido falha com `MediaProcessingError` `UNREADABLE_MEDIA` não-retryable; de um arquivo só-áudio falha com `NO_VIDEO_STREAM` não-retryable
- Um timeout do processo resulta em `MediaProcessingError` retryable
- `extractThumbnail` devolve um JPEG com largura ≤ 1280 e altura par, inclusive para um vídeo de 0,5 s
- Nenhum `metadata` nem `message` de erro contém a URL pré-assinada (`X-Amz-Signature`)

---

### SI-03.21 — VideoPipelineService: transições de processamento e limpeza para worker e sweeper

**Description:** Manter a entidade `Video` sob posse do `VideosModule`: o worker e o sweeper só alteram vídeos por métodos de um serviço de pipeline (nunca pelo repositório), todos com update guardado e idempotentes.

**Technical actions:**

1. Criar `src/videos/video-pipeline.service.ts` — `getForProcessing(videoId)` (`id`, `status`, `content_type` ou `null`), `markReady(videoId, probe)` (grava `duration_seconds`, `width`, `height`, `video_codec`, `container_format`, `bitrate_bps`, `metadata`, `status = 'ready'`, limpa `error_*`) e `markError(videoId, code, message)` — ambos via transições guardadas `processing → ready|error`, retornando se houve efeito (per `phase-03-videos/TD-04`, `TD-06`, `TD-09`)
2. Adicionar `abortExpiredDrafts(now, limit)` — para cada rascunho vencido: `StorageService.abortMultipartUpload` (tolera `NoSuchUpload`) e `deleteDraft`; retorna a contagem (per `phase-03-videos/TD-09`)
3. Adicionar `findStaleProcessingIds(olderThan, limit)` delegando a `findStaleProcessing`; registrar e exportar `VideoPipelineService` em `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoPipelineService` | Unit: `markReady`/`markError` sem efeito quando `affected = 0`, `abortExpiredDrafts` continua após `NoSuchUpload` (repo/storage mockados) | `src/videos/video-pipeline.service.spec.ts` |
| `VideoPipelineService` | Integration: DB + storage reais — transições guardadas, aborto de rascunho vencido com multipart real | `src/videos/video-pipeline.service.integration-spec.ts` |

**Dependencies:** SI-03.6, SI-03.12

**Acceptance criteria:**

- `markReady` num vídeo `processing` grava os metadados normalizados e deixa `status = 'ready'`; num vídeo já `ready` não altera nada
- `markError` num vídeo `processing` grava `error_code` e `error_message` e deixa `status = 'error'`; num vídeo `ready` não altera nada
- `abortExpiredDrafts` aborta o multipart e remove a linha de cada rascunho com `upload_expires_at` vencido e não toca rascunhos válidos
- `getForProcessing` de um id inexistente retorna `null`

---

### SI-03.22 — VideoProcessingService: metadados, thumbnail e transição para ready/error

**Description:** Orquestrar o processamento idempotente de um vídeo — URL interna pré-assinada, ffprobe, thumbnail JPEG, upload da thumbnail e transição final guardada — para que `ready` implique duração e thumbnail presentes.

**Technical actions:**

1. Criar `src/worker/video-processing.service.ts` — `process(videoId)`: `getForProcessing`; ausente/`ready`/`error`/`draft` → retorna sem trabalho (idempotência, per `phase-03-videos/TD-04`); `presignInternalGetObject(videoOriginalKey(id), expiresIn ≥ FFMPEG_TIMEOUT_MS)` (per `phase-03-videos/TD-03`, `TD-06`)
2. No `process`, executar `MediaToolsService.probe` → `extractThumbnail` (instante a 10% da duração) → `StorageService.putObject(videoThumbnailKey(id), jpeg, 'image/jpeg')` (chave determinística, sobrescreve em redelivery) → `VideoPipelineService.markReady` (per `phase-03-videos/TD-14`, `TD-10`)
3. Em erro não-retryable (`UNREADABLE_MEDIA`, `NO_VIDEO_STREAM`) chamar `markError(code, message sanitizada)` e relançar o `MediaProcessingError`; falha de thumbnail após metadados OK → `markError('THUMBNAIL_FAILED')` e relançar como não-retryable; erro retryable é apenas relançado (a decisão de `UnrecoverableError`/retry fica no processor) (per `phase-03-videos/TD-09`, `TD-14`, `TD-15`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: pula `ready`/`error`/`draft`/ausente, mapeia erros para `markError` só quando não-retryable, thumbnail falha → `THUMBNAIL_FAILED` (mocks) | `src/worker/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration: DB + storage + ffmpeg reais — original enviado via `putObject`, vídeo `processing` → `ready` com metadados e thumbnail JPEG; reexecução sem efeito; corrompido → `UNREADABLE_MEDIA`; áudio-only → `NO_VIDEO_STREAM` | `src/worker/video-processing.service.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.20, SI-03.21, SI-03.19

**Acceptance criteria:**

- Processar um vídeo `processing` com original MP4 válido o deixa `ready` com `duration_seconds`, `width`, `height`, `video_codec`, `container_format` e `bitrate_bps` preenchidos e o objeto `videos/<uuid>/thumbnail.jpg` existente com `Content-Type: image/jpeg` e largura ≤ 1280
- Processar o mesmo vídeo uma segunda vez não altera a linha nem reprocessa (retorna sem trabalho)
- Original corrompido deixa o vídeo `error` com `error_code = 'UNREADABLE_MEDIA'`; original só-áudio deixa `error` com `NO_VIDEO_STREAM`
- Falha ao gerar a thumbnail após metadados extraídos deixa o vídeo `error` com `THUMBNAIL_FAILED` (nunca `ready` sem thumbnail)
- Falha transitória (storage inacessível) não altera o status do vídeo e propaga o erro como retryable

---

### SI-03.23 — WorkerModule e VideoProcessingProcessor (retries, backoff e falha final)

**Description:** Criar o módulo do worker — único lugar com `@Processor` — que consome `video-processing`, converte erros não-retryable em `UnrecoverableError` e marca `error` quando as tentativas se esgotam.

**Technical actions:**

1. Criar `src/worker/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`; `process(job)` chama `VideoProcessingService.process(job.data.videoId)`; `MediaProcessingError` não-retryable → `throw new UnrecoverableError(...)`; retryable é relançado para o backoff do BullMQ (per `phase-03-videos/TD-05`, `TD-09`)
2. No processor, adicionar `@OnWorkerEvent('failed')`: quando `job.attemptsMade >= job.opts.attempts` (ou erro `UnrecoverableError`) e o vídeo ainda está `processing`, chamar `VideoPipelineService.markError(videoId, 'PROCESSING_FAILED', message sanitizada)` (guardado, idempotente) (per `phase-03-videos/TD-09`)
3. Criar `src/worker/worker.module.ts` — `ConfigModule.forRoot` (global, mesmos namespaces e Joi do `AppModule`), `TypeOrmModule.forRootAsync` (mesmo padrão), `QueueModule`, `StorageModule`, `MediaModule`, `VideosModule` e providers `VideoProcessingService` e `VideoProcessingProcessor`; **o `AppModule` nunca importa `WorkerModule`** (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit: não-retryable → `UnrecoverableError`, retryable relançado, handler `failed` só marca `error` na última tentativa (serviços mockados) | `src/worker/video-processing.processor.spec.ts` |
| `WorkerModule` + `VideoProcessingProcessor` | Integration: `WorkerModule` in-process com Redis/DB/storage/ffmpeg reais — job enfileirado pelo produtor → `ready`; corrompido → `error` com 1 tentativa; falha transitória simulada → retries com backoff curto e, esgotadas, `PROCESSING_FAILED`. Rodar com `video-worker` parado | `src/worker/video-processing.processor.integration-spec.ts` |

**Dependencies:** SI-03.9, SI-03.22

**Acceptance criteria:**

- Um job `video.process` para um vídeo `processing` com original válido termina com o vídeo `ready`
- Um original corrompido faz o job falhar sem novas tentativas (`attemptsMade = 1`) e o vídeo fica `error` com `UNREADABLE_MEDIA`
- Uma falha transitória é retentada até 3 vezes com backoff exponencial; esgotadas as tentativas o vídeo fica `error` com `PROCESSING_FAILED`
- Um job redelivered para um vídeo já `ready` termina com sucesso sem reprocessar
- Subir apenas o `AppModule` não consome jobs de `video-processing`; subir o `WorkerModule` consome

---

### SI-03.24 — Sweeper: job scheduler de rascunhos vencidos e reconciliação de processing

**Description:** Limpar uploads abandonados (abortar multipart e apagar o rascunho) e reenfileirar vídeos `processing` sem job vivo, executando como BullMQ job scheduler registrado na subida do worker.

**Technical actions:**

1. Criar `src/worker/video-sweeper.service.ts` — `sweep(now)`: (1) `VideoPipelineService.abortExpiredDrafts`; (2) para cada id de `findStaleProcessingIds(now − PROCESSING_STALE_MS)` chamar `VideoJobsProducer.ensureProcessingJob`; ações idempotentes (per `phase-03-videos/TD-04`, `TD-09`)
2. Criar `src/worker/video-sweeper.processor.ts` — `@Processor(VIDEO_MAINTENANCE_QUEUE)` que executa `VideoSweeperService.sweep`; erros são logados e relançados para o retry do job (`attempts: 3`, `backoff: 3000`, `removeOnFail: 1000` como no exemplo da `library-refs.md`) (per `phase-03-videos/TD-09`)
3. No `WorkerModule`, registrar o scheduler em `OnModuleInit` com `queue.upsertJobScheduler('video-sweeper', { every: SWEEPER_INTERVAL_MS }, { name: 'video.sweep', data: {}, opts })` (idempotente a cada boot; scheduler não aceita `jobId` custom) e prover `VideoSweeperService`/`VideoSweeperProcessor` (per `phase-03-videos/TD-09`; BullMQ job scheduler, não `@nestjs/schedule`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoSweeperService` | Unit: ordem das ações, `ensureProcessingJob` chamado para cada vídeo stale, falha de uma etapa não impede a outra (mocks) | `src/worker/video-sweeper.service.spec.ts` |
| `VideoSweeperService` + scheduler | Integration: Redis/DB/storage reais — rascunho vencido com multipart real é abortado e apagado; `processing` antigo sem job é reenfileirado; com job vivo não duplica; `upsertJobScheduler` repetido mantém um único scheduler. Rodar com `video-worker` parado | `src/worker/video-sweeper.service.integration-spec.ts` |

**Dependencies:** SI-03.9, SI-03.21, SI-03.23

**Acceptance criteria:**

- Após `sweep`, um rascunho com `upload_expires_at` vencido deixa de existir em `videos` e seu multipart deixa de existir no storage; um rascunho válido permanece
- Um vídeo `processing` com `processing_started_at` anterior ao limite e sem job na fila ganha um job `process-video-<uuid>`
- Um vídeo `processing` que já tem job vivo não recebe um segundo job
- Subir o `WorkerModule` duas vezes seguidas deixa exatamente um job scheduler `video-sweeper` com `every = SWEEPER_INTERVAL_MS`
- Os testes que criam rascunhos vencidos ou `processing` antigos só rodam com o serviço `video-worker` do Compose parado, para que o sweeper do container não toque nas linhas de teste

---

### SI-03.25 — Entrypoint worker.ts e serviço video-worker no Compose

**Description:** Criar o entrypoint do worker (contexto de aplicação sem HTTP) e o serviço `video-worker` que sobe automaticamente com `docker compose up`, com dependências saudáveis e saída de build separada da API.

**Technical actions:**

1. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` com `app.enableShutdownHooks()` (fecha workers e filas no shutdown) (per `phase-03-videos/TD-05`)
2. Criar `tsconfig.worker.json` (estende `tsconfig.build.json` com `outDir: dist-worker`), o script `start:worker` = `nest start -p tsconfig.worker.json --entryFile worker --watch` e adicionar `/dist-worker` ao `.gitignore`. **Desvio de plano em relação ao comando literal da TD-05** (`nest start --entryFile worker --watch`): o `outDir` separado evita que o `deleteOutDir: true` de `nest-cli.json` apague a saída do worker (e vice-versa) quando a API roda `start:dev`/`build` no mesmo bind mount — _parâmetro de implementação — sem TD_
3. Adicionar o serviço `video-worker` ao `compose.yaml` — `build` com o mesmo `Dockerfile.dev`, volume `.:/home/node/app`, `command: npm run start:worker` (**autostart**, per `phase-03-videos/TD-05` confirmada pelo usuário), `depends_on`: `db`, `redis` e `minio` com `service_healthy` e `minio-init` com `service_completed_successfully` (per `phase-03-videos/TD-10`); sem portas publicadas
4. Subir o serviço e validar que consome a fila: `docker compose up -d video-worker`, logs sem erro, vídeo de teste enfileirado vira `ready`

**Tests:** _(empty — Infra/entrypoint; comportamento coberto em SI-03.23 e SI-03.29)_

**Dependencies:** SI-03.2, SI-03.23, SI-03.24

**Acceptance criteria:**

- `docker compose up -d` sobe `video-worker` automaticamente e `docker compose ps` o mostra `running` somente depois de `db`, `redis` e `minio` saudáveis e de `minio-init` concluído
- `docker compose logs video-worker` não contém erro de bootstrap e o processor de `video-processing` está ativo (um job enfileirado é consumido)
- `npm run start:dev` da API e `npm run start:worker` rodando ao mesmo tempo não apagam a saída um do outro; `npm run build` da API não apaga `dist-worker` e vice-versa
- `docker compose stop video-worker` encerra o worker de forma limpa (shutdown hooks) e a suíte de testes passa a rodar sem consumidor/sweeper do container concorrendo pelo banco compartilhado
- Nenhuma porta é publicada pelo serviço `video-worker`

---

### SI-03.26 — VideoDeliveryService: URLs pré-assinadas de streaming e download

**Description:** Autorizar a leitura pública de vídeos `ready` e gerar a URL pré-assinada de `GetObject` (host público) com `Content-Type` forçado e, no download, `Content-Disposition: attachment`; o `206` é responsabilidade do storage.

**Technical actions:**

1. Criar `src/videos/content-disposition.util.ts` — `buildAttachmentDisposition(fileName)` que remove CR/LF e aspas/barras do nome e emite `attachment; filename="<ascii>"; filename*=UTF-8''<percent-encoded>` (segurança de header, per `phase-03-videos/TD-08`)
2. Criar `src/videos/video-delivery.service.ts` — `getStreamUrl(publicId)` e `getDownloadUrl(publicId)`: `findByPublicId` sem filtro de canal; ausente ou `status ≠ 'ready'` → `VideoNotFoundException`; `StorageService.presignGetObject(videoOriginalKey(id), { responseContentType: content_type, responseContentDisposition? })` (per `phase-03-videos/TD-08`, `TD-11`, `TD-15`)
3. Registrar e exportar `VideoDeliveryService` em `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `buildAttachmentDisposition` | Unit: sanitização de aspas/CRLF, nome não-ASCII, `filename*` | `src/videos/content-disposition.util.spec.ts` |
| `VideoDeliveryService` | Unit: 404 para inexistente e para `draft`/`processing`/`error`, parâmetros passados ao presign (storage mockado) | `src/videos/video-delivery.service.spec.ts` |
| `VideoDeliveryService` | Integration: storage real — URL de stream responde `200` com o `Content-Type` salvo e `206` + `Content-Range` para `Range`; URL de download responde com `Content-Disposition: attachment` (host override) | `src/videos/video-delivery.service.integration-spec.ts` |

**Dependencies:** SI-03.4, SI-03.6, SI-03.7

**Acceptance criteria:**

- `getStreamUrl` de um vídeo `ready` devolve uma URL de `GetObject` para `videos/<uuid>/original` no host de `S3_PUBLIC_ENDPOINT` que, acessada com `Range: bytes=0-99`, retorna `206` com `Content-Range` e `Accept-Ranges`
- `getDownloadUrl` devolve uma URL que, acessada, retorna o header `Content-Disposition: attachment; filename="<nome original>"`
- Para um vídeo que não está `ready`, ou inexistente, ambos falham com `VideoNotFoundException`
- Um `original_file_name` com aspas ou quebras de linha nunca produz header com essas sequências

---

### SI-03.27 — Endpoint GET /videos/:id/stream (redirect 302 para URL pré-assinada)

**Route:** GET /videos/:id/stream
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Public

**Description:** Expor o streaming público de vídeos `ready` por redirect para o storage, que atende Range (`206`) sem o arquivo passar pela API.

**Technical actions:**

1. Adicionar ao `VideosController` o handler `GET :id/stream` com `@Public()` e `@Redirect()` retornando `{ url, statusCode: 302 }` de `VideoDeliveryService.getStreamUrl` (per `phase-03-videos/TD-08`, `TD-11`; Tech Spec `### API Contracts → GET /videos/:id/stream`)
2. Documentar com `@ApiOperation`, `@ApiParam`, `@ApiResponse` 302 (header `Location`) e 404 com `ApiErrorEnvelope`; sem `@ApiBearerAuth` nesta rota

**Tests:** _(empty — controller wiring; E2E scenarios authored via /plan-test-specs spec)_

**Dependencies:** SI-03.13, SI-03.26

**Acceptance criteria:**

- `GET /videos/:id/stream` sem token para um vídeo `ready` retorna `302` com `Location` apontando para o host de `S3_PUBLIC_ENDPOINT`
- Seguir o `Location` com `Range: bytes=0-99` retorna `206` com `Content-Range` e `Accept-Ranges` emitidos pelo storage (asserção contra a URL pré-assinada)
- Para um vídeo `draft`, `processing` ou `error`, ou id inexistente, retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.28 — Endpoint GET /videos/:id/download (redirect 302 com Content-Disposition)

**Route:** GET /videos/:id/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** Public

**Description:** Expor o download público de vídeos `ready` por redirect para uma URL pré-assinada que força `Content-Disposition: attachment`.

**Technical actions:**

1. Adicionar ao `VideosController` o handler `GET :id/download` com `@Public()` e `@Redirect()` retornando `{ url, statusCode: 302 }` de `VideoDeliveryService.getDownloadUrl` (per `phase-03-videos/TD-08`; Tech Spec `### API Contracts → GET /videos/:id/download`)
2. Documentar com `@ApiOperation`, `@ApiParam`, `@ApiResponse` 302 (header `Location`) e 404 com `ApiErrorEnvelope`

**Tests:** _(empty — controller wiring; E2E scenarios authored via /plan-test-specs spec)_

**Dependencies:** SI-03.13, SI-03.26

**Acceptance criteria:**

- `GET /videos/:id/download` sem token para um vídeo `ready` retorna `302` com `Location` contendo `response-content-disposition` com `attachment`
- Seguir o `Location` retorna `200` com `Content-Disposition: attachment; filename="<nome original>"`
- Para um vídeo que não está `ready`, ou inexistente, retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.29 — Pipeline ponta a ponta: upload multipart, processamento in-process e streaming

**Description:** Provar o fluxo completo com serviços reais do Compose, importando `AppModule` e `WorkerModule` no mesmo processo de teste, e cobrir o caminho de falha de um arquivo corrompido.

**Technical actions:**

1. Criar `test/video-pipeline.e2e-spec.ts` — `AppModule` + `WorkerModule` in-process (replicando `ValidationPipe` e filtros do `main.ts`), bucket de teste dedicado e prefixo de fila únicos por execução, `UPLOAD_PART_SIZE_BYTES = 5242880`; fluxo: registrar/confirmar/logar → `POST /videos` → `part-urls` → PUT das partes (helper com host override) → `GET …/upload/parts` → `complete` → polling de `GET /videos/:id` até `ready` → `stream` (`302`) → `Range` na URL pré-assinada retorna `206` → `download` com `Content-Disposition` (per `phase-03-videos/TD-12`, `TD-08`)
2. No mesmo spec, cenário de falha: arquivo corrompido com `content_type = video/mp4` termina `error` com `UNREADABLE_MEDIA` e `stream` responde `404`; cenário de retomada: enviar só a parte 1, consultar `upload/parts`, reenviar a parte 2 e completar
3. Estender o helper de limpeza dos e2e para apagar `videos` (via `cleanAllTables`) e remover o bucket/prefixo de teste no `afterAll`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline de vídeo (`AppModule` + `WorkerModule`) | E2E: initiate → partes → complete → `ready` → stream `302`/`206` → download; corrompido → `error`; retomada por `ListParts` — rodar com `video-worker` parado, timeouts generosos | `test/video-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.14, SI-03.15, SI-03.16, SI-03.17, SI-03.18, SI-03.25, SI-03.27, SI-03.28

**Acceptance criteria:**

- Um arquivo de ≥ 6 MiB enviado em 2 partes de 5 MiB e finalizado chega a `ready` com `duration_seconds` e `bitrate_bps` preenchidos e thumbnail JPEG no storage
- `GET /videos/:id/stream` de um vídeo `ready` retorna `302` e a requisição com `Range` à URL pré-assinada retorna `206`
- Um arquivo corrompido enviado e completado termina com `status: "error"`, `error_code: "UNREADABLE_MEDIA"`, e `GET /videos/:id/stream` retorna `404`
- Após enviar apenas a parte 1, `GET /videos/:id/upload/parts` lista a parte 1 e o upload é completado após reenviar a parte 2
- A suíte e2e passa com o serviço `video-worker` do Compose parado (`docker compose stop video-worker`), sem interferência do sweeper do container

---

### SI-03.30 — Regenerar openapi.json com os endpoints de vídeo

**Description:** Atualizar o contrato OpenAPI versionado (`openapi.json`, consumido pelo frontend) com as rotas de vídeo documentadas nos SIs de controller.

**Technical actions:**

1. Rodar `docker compose exec nestjs-api npm run openapi:export` e versionar o `nestjs-project/openapi.json` atualizado (per `openapi-docs-nestjs/TD-02`)
2. Estender `test/swagger.e2e-spec.ts` para afirmar a presença das oito rotas de `/videos`, a tag `videos`, os schemas de resposta e a referência a `ApiErrorEnvelope` nos erros

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Documento OpenAPI (`/videos/**`) | E2E: paths, tag `videos`, schemas e envelope de erro presentes (existing file extended) | `test/swagger.e2e-spec.ts` |

**Dependencies:** SI-03.13, SI-03.14, SI-03.15, SI-03.16, SI-03.17, SI-03.18, SI-03.27, SI-03.28

**Acceptance criteria:**

- O `openapi.json` exportado contém os caminhos `/videos`, `/videos/{id}`, `/videos/{id}/upload/part-urls`, `/videos/{id}/upload/parts`, `/videos/{id}/upload/complete`, `/videos/{id}/upload`, `/videos/{id}/stream` e `/videos/{id}/download`
- Cada operação de vídeo declara resposta de sucesso e as respostas de erro previstas no `### API Contracts`
- Rodar `openapi:export` novamente não produz diff no arquivo

---

### SI-03.31 — Documentação: CLAUDE.md raiz, nestjs-project/CLAUDE.md, README e diagrama

**Description:** Registrar o módulo de vídeos, os endpoints, a fila/worker, o storage e as regras de teste/ambiente nos documentos vinculantes, e anotar que o "MinIO" do enunciado é atendido pelo fork `pgsty/silo`.

**Technical actions:**

1. Atualizar `CLAUDE.md` (raiz): módulo `videos` e endpoints na estrutura, **Message Queue** = BullMQ + Redis (não publicado), **Object Storage** = S3-compatível `pgsty/silo` + `pgsty/mc` (fork do MinIO, que satisfaz o "S3/MinIO"; upstream arquivado), Video Worker com `src/worker.ts` (per `phase-03-videos/TD-01`, `TD-05`, `TD-13`)
2. Atualizar `nestjs-project/CLAUDE.md`: serviços do Compose (`redis`, `minio`, `minio-init`, `video-worker`), health checks (`redis-cli ping`, storage), script `start:worker` e saída `dist-worker`, `ffmpeg` na imagem, exceção explícita de autostart do `video-worker` à regra "nunca iniciar o servidor", **regra de testes: rodar as suítes com `docker compose stop video-worker`** (worker e sweeper do container disputam o banco compartilhado), variáveis de ambiente novas (`UPLOAD_PART_SIZE_BYTES`, `UPLOAD_MAX_BYTES`, `S3_*`, `REDIS_*`, `QUEUE_PREFIX`, …), `.env` local a atualizar a partir do `.env.example`
3. Atualizar `docs/diagrams/software-arch.mermaid` (fila "BullMQ + Redis", storage "S3-compatible (pgsty/silo, MinIO fork)") e a linha de Object Storage do `README.md`

**Tests:** _(empty — documentação; sem artefato testável)_

**Dependencies:** SI-03.29, SI-03.30

**Acceptance criteria:**

- O `CLAUDE.md` raiz descreve a fila como BullMQ + Redis e o storage como S3-compatível `pgsty/silo`, indicando que o fork atende o "S3/MinIO" do enunciado
- O `nestjs-project/CLAUDE.md` lista `redis`, `minio`, `minio-init` e `video-worker`, o comando `start:worker` e a regra de parar o `video-worker` antes de rodar as suítes
- O diagrama `software-arch.mermaid` não contém mais a fila como "TBD"
- Nenhum documento instrui a publicar a porta do Redis no host

---

## Technical Specifications

### Data Model

> Legenda de rastreabilidade: itens sem TD de origem estão marcados `(parâmetro de implementação — sem TD; default proposto)` e listados nas pendências do relatório de build.

#### Video (table `videos`) (SI-03.5)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal id; used in storage keys and as the job payload (per `phase-03-videos/TD-10`, `TD-07`) |
| public_id | varchar(11) | unique, not null | 11-char base62 (`[0-9A-Za-z]`) generated with `crypto.randomInt`; unique constraint + retry on `23505` (per `phase-03-videos/TD-07`) |
| channel_id | uuid | FK → `channels.id`, not null | Owner channel; channels are 1:1 with users (per `phase-03-videos/TD-11`). FK without cascade (default `NO ACTION`) — _parâmetro de implementação — sem TD; default proposto_ |
| status | enum `video_status` | not null, default `'draft'` | `draft` → `processing` → `ready` \| `error`; guarded transitions only (per `phase-03-videos/TD-09`) |
| original_file_name | varchar(255) | not null | Client-declared file name; used to build the download `Content-Disposition` |
| content_type | varchar(255) | not null | Declared type, must start with `video/` (per `phase-03-videos/TD-15`); stored as object metadata and returned as `ResponseContentType` (per `phase-03-videos/TD-08`) |
| size_bytes | bigint | not null | Declared size, ≤ `UPLOAD_MAX_BYTES`; verified with `HeadObject` at complete (per `phase-03-videos/TD-04`). Transformer string ⇄ number |
| part_size | bigint | not null | Server-chosen multipart part size (per `phase-03-videos/TD-02`). Transformer string ⇄ number |
| part_count | integer | not null | `ceil(size_bytes / part_size)`, ≤ 10,000 (per `phase-03-videos/TD-02`) |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId`; set at initiate, cleared (`NULL`) after complete/abort (per `phase-03-videos/TD-02`) |
| upload_expires_at | timestamptz | nullable | Deadline of the draft; read by the sweeper (per `phase-03-videos/TD-09`) |
| processing_started_at | timestamptz | nullable | Set on `draft → processing`; sweeper reconciliation threshold reads it — _parâmetro de implementação — sem TD; coluna necessária para o "older than a threshold" de `phase-03-videos/TD-04`/`TD-09`_ |
| duration_seconds | numeric(12,3) | nullable | ffprobe `format.duration` (per `phase-03-videos/TD-06`) |
| width | integer | nullable | First video stream (per `phase-03-videos/TD-06`) |
| height | integer | nullable | First video stream (per `phase-03-videos/TD-06`) |
| video_codec | varchar(64) | nullable | First video stream `codec_name` (per `phase-03-videos/TD-06`) |
| container_format | varchar(255) | nullable | ffprobe `format.format_name` (per `phase-03-videos/TD-06`) |
| bitrate_bps | bigint | nullable | ffprobe `format.bit_rate`. Transformer string ⇄ number (per `phase-03-videos/TD-06`) |
| metadata | jsonb | nullable | Trimmed ffprobe output: `{ format, streams[] }` with `format.filename` removed (it contains the presigned URL) (per `phase-03-videos/TD-06`) |
| error_code | varchar(64) | nullable | Reason code when `status = 'error'` (per `phase-03-videos/TD-09`); values in the Error Catalog "Processing failure codes" table |
| error_message | text | nullable | Sanitized reason (never contains presigned URLs) (per `phase-03-videos/TD-09`) |
| created_at | timestamptz | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamptz | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** `Video` many-to-one `Channel` (`channel_id`); `Channel` one-to-many `Video` (inverse side added without schema change)
**Indexes:** unique on `public_id`; index on `channel_id`; index on `status` (sweeper scans) — _índice em `status`: parâmetro de implementação — sem TD_
**Invariants:** `ready` implies `duration_seconds` and the thumbnail object exist (per `phase-03-videos/TD-14`); `draft` rows with `upload_expires_at < now()` are aborted and deleted by the sweeper (per `phase-03-videos/TD-09`).

**Object keys (single bucket `S3_BUCKET`, default `streamtube`) (per `phase-03-videos/TD-10`):**

- `videos/{id}/original` — uploaded file; `Content-Type` stored as object metadata.
- `videos/{id}/thumbnail.jpg` — generated JPEG, `Content-Type: image/jpeg`.

`{id}` is the internal `videos.id` (uuid), never the public id.

### API Contracts

> Wire format: JSON in `snake_case` (field `part_size` is verbatim from `phase-03-videos/TD-02`; the remaining names follow it). The `:id` path parameter is the **public id** (`videos.public_id`). Error body is the inherited envelope `{ statusCode, error, message }` (per `phase-02-auth/TD-07`). Unauthenticated calls to protected routes are answered `401` by the global `JwtAuthGuard` (inherited).

#### POST /videos (SI-03.13)

Creates the draft video, starts the S3 multipart upload and returns the part plan (per `phase-03-videos/TD-02`, `TD-09`).

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- file_name: string, required — 1–255 characters
- size_bytes: integer, required — ≥ 1; `> UPLOAD_MAX_BYTES` is rejected by the service (413)
- content_type: string, required — must start with `video/` (per `phase-03-videos/TD-15`)

**Response 201:**
- id: string — public id (11 chars base62)
- status: string — `draft`
- part_size: integer — bytes; the client MUST slice the file with this size (last part may be smaller)
- part_count: integer
- expires_at: string (ISO 8601) — `upload_expires_at`

**Error responses:**
- 400 VALIDATION_ERROR: body fails schema validation
- 401: missing/invalid access token (inherited guard)
- 404 CHANNEL_NOT_FOUND: authenticated user has no channel
- 413 UPLOAD_SIZE_EXCEEDS_LIMIT: `size_bytes` > `UPLOAD_MAX_BYTES`
- 415 INVALID_CONTENT_TYPE: `content_type` does not start with `video/`

---

#### POST /videos/:id/upload/part-urls (SI-03.14)

Issues (or re-issues) presigned `UploadPart` URLs for the requested part numbers (per `phase-03-videos/TD-02`).

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — non-empty, at most 10,000 items, each ≥ 1; each must be ≤ `part_count` (checked by the service); duplicates are collapsed

**Response 200:**
- parts: array of `{ part_number: integer, url: string }` — `url` is signed for `S3_PUBLIC_ENDPOINT` (per `phase-03-videos/TD-03`); the client `PUT`s the raw part bytes and keeps the response `ETag` header
- expires_in: integer — seconds until the URLs expire (`PRESIGN_EXPIRES_SECONDS`)

**Error responses:**
- 400 VALIDATION_ERROR: body fails schema validation
- 400 INVALID_PART_NUMBER: a part number is greater than `part_count`
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: video does not exist or belongs to another channel (per `phase-03-videos/TD-11`)
- 409 VIDEO_NOT_IN_DRAFT: video is no longer `draft`
- 410 UPLOAD_EXPIRED: `upload_expires_at` is in the past

---

#### GET /videos/:id/upload/parts (SI-03.15)

Lists the parts already stored (`ListParts`) so the client can resume after a connection failure (per `phase-03-videos/TD-02`; origin `docs/project-plan.md` §4 "Pontos de Atenção").

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- part_size: integer
- part_count: integer
- parts: array of `{ part_number: integer, size: integer, etag: string }` — all pages of `ListParts` aggregated, ascending by `part_number`

**Error responses:**
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: video does not exist or belongs to another channel
- 409 VIDEO_NOT_IN_DRAFT: video is no longer `draft`
- 410 UPLOAD_EXPIRED: `upload_expires_at` is in the past

---

#### POST /videos/:id/upload/complete (SI-03.16)

Finalizes the multipart upload, verifies the object size, moves the video to `processing` and enqueues the processing job (per `phase-03-videos/TD-04`).

**Request headers:**
- Authorization: Bearer `<access_token>`
- Content-Type: application/json

**Request body:**
- parts: array, required — non-empty; each item `{ part_number: integer ≥ 1, etag: string, non-empty }` (ETag exactly as returned by storage)

**Response 202:**
- id: string — public id
- status: string — `processing`
- original_file_name, content_type, size_bytes: as stored
- duration_seconds, width, height, video_codec, container_format, bitrate_bps: `null` until processed
- error_code, error_message: `null`
- created_at, updated_at: string (ISO 8601)

**Error responses:**
- 400 VALIDATION_ERROR: body fails schema validation
- 400 INVALID_UPLOAD_PARTS: storage rejected the part list (missing part, wrong ETag/order, part below the minimum size)
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: video does not exist or belongs to another channel
- 409 VIDEO_NOT_IN_DRAFT: video is no longer `draft` (a repeated `complete` is a conflict, per `phase-03-videos/TD-04`)
- 409 UPLOAD_SIZE_MISMATCH: stored object size differs from `size_bytes`; the video becomes `error`
- 410 UPLOAD_EXPIRED: `upload_expires_at` is in the past

---

#### DELETE /videos/:id/upload (SI-03.17)

Aborts the multipart upload and deletes the draft row (same cleanup the sweeper performs; per `phase-03-videos/TD-02`, `TD-09`).

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 204:** No content.

**Error responses:**
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: video does not exist or belongs to another channel
- 409 VIDEO_NOT_IN_DRAFT: video is no longer `draft`

---

#### GET /videos/:id (SI-03.18)

Owner's status endpoint (per `phase-03-videos/TD-11`).

**Request headers:**
- Authorization: Bearer `<access_token>`

**Response 200:**
- id: string — public id
- status: string — `draft` | `processing` | `ready` | `error`
- original_file_name: string
- content_type: string
- size_bytes: integer
- duration_seconds: number | null
- width: integer | null
- height: integer | null
- video_codec: string | null
- container_format: string | null
- bitrate_bps: integer | null
- error_code: string | null
- error_message: string | null
- created_at: string (ISO 8601)
- updated_at: string (ISO 8601)

**Error responses:**
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: video does not exist or belongs to another channel

---

#### GET /videos/:id/stream (SI-03.27)

Public. Authorizes, then redirects to a short-lived presigned `GetObject` URL on `S3_PUBLIC_ENDPOINT`; Range handling (`206`, `Accept-Ranges`, `Content-Range`) is emitted by object storage, not by the API (per `phase-03-videos/TD-08`).

**Response 302:**
- Location: presigned GET URL for `videos/{uuid}/original` with `response-content-type` = stored `content_type`

**Error responses:**
- 404 VIDEO_NOT_FOUND: video does not exist or `status != 'ready'` (anonymous users may stream any `ready` video, per `phase-03-videos/TD-08`)

---

#### GET /videos/:id/download (SI-03.28)

Public. Same as stream, plus `response-content-disposition=attachment; filename=…` signed into the URL so the storage engine emits `Content-Disposition` (per `phase-03-videos/TD-08`).

**Response 302:**
- Location: presigned GET URL with `response-content-disposition` = `attachment; filename="<sanitized original_file_name>"` and `response-content-type` = stored `content_type`

**Error responses:**
- 404 VIDEO_NOT_FOUND: video does not exist or `status != 'ready'`

---

#### Validation Rules — Video upload

- `file_name`: required string, 1–255 characters.
- `size_bytes`: required integer ≥ 1 (class-validator); the upper bound is `UPLOAD_MAX_BYTES` (default `10737418240` = 10 GiB), enforced by the service as a domain error (413).
- `content_type`: required string; the service requires the `video/` prefix (415). ffprobe in the worker is the authoritative validator (per `phase-03-videos/TD-15`).
- `part_numbers`: required non-empty integer array, items ≥ 1, at most 10,000 items (S3 part cap, per `phase-03-videos/TD-02`); upper bound `part_count` enforced by the service.
- `parts`: required non-empty array of `{ part_number: integer ≥ 1, etag: non-empty string }`.
- Part size rule (planner): `part_size = max(UPLOAD_PART_SIZE_BYTES, 5 MiB, ceil(size_bytes / 10000))`; default `UPLOAD_PART_SIZE_BYTES` = 64 MiB (67108864) (per `phase-03-videos/TD-02`).
- Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`) is inherited from `phase-02-auth`; validation failures return `VALIDATION_ERROR`.

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | ✓ (video is created under the caller's channel) |
| POST /videos/:id/upload/part-urls | ✗ | ✗ | ✓ (404 for any other user) |
| GET /videos/:id/upload/parts | ✗ | ✗ | ✓ (404 for any other user) |
| POST /videos/:id/upload/complete | ✗ | ✗ | ✓ (404 for any other user) |
| DELETE /videos/:id/upload | ✗ | ✗ | ✓ (404 for any other user) |
| GET /videos/:id | ✗ | ✗ | ✓ (404 for any other user) |
| GET /videos/:id/stream | ✓ | ✓ | ✓ (only `status = 'ready'`; otherwise 404) |
| GET /videos/:id/download | ✓ | ✓ | ✓ (only `status = 'ready'`; otherwise 404) |

Rules (per `phase-03-videos/TD-11`, `TD-08`): the channel is resolved in the service from the JWT `sub` (`channels.user_id`); every management query filters by `channel_id`; a video that does not exist and a video of another channel yield the same `VIDEO_NOT_FOUND` (404). Only `stream` and `download` carry `@Public()`; Phase 04 layers visibility on top.

### Error Catalog

Error response format (inherited, per `phase-02-auth/TD-07`): `{ statusCode: number, error: string, message: string }`; validation errors use `error: "VALIDATION_ERROR"` and an array `message`. `DomainExceptionFilter` is generic (`httpStatus` + `errorCode` from the exception), so each code below is a `DomainException` subclass and needs no new filter. Codes and statuses are _parâmetro de implementação — sem TD (nomes e status propostos; `413`/`415`/`410` escolhidos pelo plano; a TD-15 só pede "`400`/`415`-style domain error")_.

| errorCode | HTTP | Message | Trigger |
|-----------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Video id unknown, owned by another channel, or (stream/download) not `ready` |
| CHANNEL_NOT_FOUND | 404 | Channel not found | Authenticated user without a channel row |
| INVALID_CONTENT_TYPE | 415 | Content type must be a video type | `POST /videos` with `content_type` not starting with `video/` |
| UPLOAD_SIZE_EXCEEDS_LIMIT | 413 | Upload size exceeds the allowed limit | `POST /videos` with `size_bytes` > `UPLOAD_MAX_BYTES` |
| VIDEO_NOT_IN_DRAFT | 409 | Video is not in draft status | part-urls / parts / complete / abort on a video whose status is not `draft`; repeated `complete` |
| UPLOAD_EXPIRED | 410 | Upload has expired | part-urls / parts / complete after `upload_expires_at` |
| INVALID_PART_NUMBER | 400 | Part number out of range | `part_numbers` item greater than `part_count` |
| INVALID_UPLOAD_PARTS | 400 | Uploaded parts are invalid | Storage rejects `CompleteMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`) |
| UPLOAD_SIZE_MISMATCH | 409 | Uploaded size does not match the declared size | `HeadObject` size ≠ `size_bytes` after completion; video moved to `error` |

**Processing failure codes** (persisted in `videos.error_code`, never an HTTP error; per `phase-03-videos/TD-09`, `TD-14`, `TD-15`):

| error_code | Retryable | Trigger |
|------------|-----------|---------|
| UNREADABLE_MEDIA | no (`UnrecoverableError`) | ffprobe cannot read the object (corrupt/unsupported) |
| NO_VIDEO_STREAM | no (`UnrecoverableError`) | ffprobe succeeds but there is no video stream |
| THUMBNAIL_FAILED | no after metadata succeeded (video becomes `error`, per `phase-03-videos/TD-14`) | ffmpeg frame extraction/upload fails |
| UPLOAD_SIZE_MISMATCH | n/a | Set by `complete` (see table above) |
| PROCESSING_FAILED | yes → after `attempts: 3` exhausted | Transient failure (storage unreachable, ffmpeg/ffprobe timeout) persisted by the worker's final-failure handler |

### Events/Messages

> Queue technology: BullMQ + Redis (`REDIS_HOST=redis`, `REDIS_PORT=6379`, never published to the host) (per `phase-03-videos/TD-01`). Two queues — _`video-processing` e `video-maintenance` separadas: parâmetro de implementação — sem TD_. Producers are registered only in `AppModule` (through `QueueModule`); `@Processor` classes are provided only in `WorkerModule` (entrypoint `src/worker.ts`) (per `phase-03-videos/TD-05`).

#### video.process

**Queue:** `video-processing`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job id:** `process-video-{videoId}` — deterministic (per `phase-03-videos/TD-04`). The library cache example uses `process-video:{videoId}`; BullMQ restricts `:` in custom ids, so the dash form is the plan's choice and MUST be asserted by the producer integration test (SI-03.9); fall back to the cache form only if that test shows `:` is accepted and the dash is rejected.
**Job options:** `attempts: 3`, `backoff: { type: 'exponential', delay: 30000, jitter }` (per `phase-03-videos/TD-09`).
**Producer:** `VideoJobsProducer` (called by `VideosService.completeUpload` after the guarded `draft → processing`, and by `VideoSweeperService` reconciliation) (per `phase-03-videos/TD-04`)
**Consumer:** `VideoProcessingProcessor` in `WorkerModule` (per `phase-03-videos/TD-05`)
**Trigger:** `POST /videos/:id/upload/complete` succeeded in `CompleteMultipartUpload`, size check and `draft → processing`; also the sweeper when a `processing` video has no live job.
**Delivery semantics:** at-least-once; the consumer is idempotent — deterministic thumbnail key, metadata overwrite, final guarded `processing → ready|error` update, and a redelivered job on a `ready`/`error`/missing/`draft` video acks without work (per `phase-03-videos/TD-04`).
**Failure handling:** non-retryable errors (`UNREADABLE_MEDIA`, `NO_VIDEO_STREAM`, `THUMBNAIL_FAILED`) throw `UnrecoverableError` (no retries); when attempts are exhausted the worker's final-failure handler sets `status = 'error'`, `error_code = 'PROCESSING_FAILED'`; no automatic re-enqueue from `error` (per `phase-03-videos/TD-09`). The `failed` set plus the video row is the dead-letter record (per `phase-03-videos/TD-01`).

#### video.sweep

**Queue:** `video-maintenance`

**Payload:**

```json
{}
```

**Scheduler:** BullMQ job scheduler id `video-sweeper`, `every: SWEEPER_INTERVAL_MS`, registered with `upsertJobScheduler` on worker boot (idempotent; scheduler jobs cannot carry a custom job id) (per `phase-03-videos/TD-09`).
**Producer:** the job scheduler itself (registered by `WorkerModule`)
**Consumer:** `VideoSweeperProcessor` in `WorkerModule` → `VideoSweeperService.sweep()`
**Trigger:** every `SWEEPER_INTERVAL_MS` (default 300000 — _default proposto, exemplo de `library-refs.md`_).
**Actions:** (1) for `draft` rows with `upload_expires_at < now()`: `AbortMultipartUpload` then delete the row; (2) for `processing` rows with `processing_started_at < now() - PROCESSING_STALE_MS` and no live job: re-enqueue via `VideoJobsProducer.ensureProcessingJob` (removes a stale failed/completed job record that would otherwise block the deterministic id) (per `phase-03-videos/TD-04`, `TD-09`).
**Delivery semantics:** at-least-once; every action is idempotent (guarded deletes/aborts tolerate `NoSuchUpload`).


---

## Dependency Map

Pré-requisito externo (fora de escopo desta fase, não é SI): a branch `bugfix` separada com o baseline de lint (150 erros pré-existentes) e a correção de `migrations.integration-spec.ts` deve estar mesclada em `dev` antes de iniciar a fase (a Definition of Done exige `npm run lint` verde).

```
SI-03.1 (Spike storage — root, pré-requisito externo: bugfix de lint/migrations spec)
├── SI-03.3 (também depende de SI-03.2)
│   ├── SI-03.4 (também depende de SI-03.1)
│   └── SI-03.9 (também depende de SI-03.2)
SI-03.2 (ffmpeg + Redis — root)
├── SI-03.3
├── SI-03.9
└── SI-03.19
    └── SI-03.20 (também depende de SI-03.4)

SI-03.5 (entidade Video — root)
└── SI-03.6
SI-03.7 (exceções — root)
└── SI-03.8

SI-03.4 + SI-03.6 + SI-03.7 + SI-03.8
└── SI-03.10
    ├── SI-03.11
    │   └── SI-03.12 (também depende de SI-03.9)
    └── SI-03.13
        ├── SI-03.14 (também depende de SI-03.11)
        ├── SI-03.15 (também depende de SI-03.11)
        ├── SI-03.16 (também depende de SI-03.12)
        ├── SI-03.17 (também depende de SI-03.12)
        └── SI-03.18 (também depende de SI-03.6)

SI-03.6 + SI-03.12
└── SI-03.21
    └── SI-03.22 (também depende de SI-03.4, SI-03.19, SI-03.20)
        └── SI-03.23 (também depende de SI-03.9)
            └── SI-03.24 (também depende de SI-03.9, SI-03.21)
                └── SI-03.25 (também depende de SI-03.2, SI-03.23)

SI-03.4 + SI-03.6 + SI-03.7
└── SI-03.26
    ├── SI-03.27 (também depende de SI-03.13)
    └── SI-03.28 (também depende de SI-03.13)

SI-03.14 + SI-03.15 + SI-03.16 + SI-03.17 + SI-03.18 + SI-03.25 + SI-03.27 + SI-03.28
├── SI-03.29 (pipeline E2E)
└── SI-03.30 (openapi.json — sem SI-03.25/SI-03.29)

SI-03.29 + SI-03.30
└── SI-03.31 (documentação)
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.14, SI-03.15, SI-03.16, SI-03.17, SI-03.18 (paralelos) → SI-03.19 → SI-03.20 → SI-03.21 → SI-03.22 → SI-03.23 → SI-03.24 → SI-03.25 → SI-03.26 → SI-03.27, SI-03.28 (paralelos) → SI-03.29, SI-03.30 (paralelos) → SI-03.31

Regra transversal de testes: a partir do SI-03.25 o serviço `video-worker` autostarta; todas as suítes que criam rascunhos vencidos, vídeos `processing` ou jobs (SI-03.23, SI-03.24, SI-03.29 e a suíte completa) devem rodar com `docker compose stop video-worker`, pois o worker e o sweeper do container usam o mesmo banco compartilhado dos testes.

---

## Deliverables

- [ ] SI-03.1 — Spike: storage S3-compatível (pgsty/silo + pgsty/mc) no Compose e contrato S3
- [ ] SI-03.2 — Infra: ffmpeg no Dockerfile.dev e serviço Redis no Compose
- [ ] SI-03.3 — Dependências de fila, namespaces de configuração e validação Joi
- [ ] SI-03.4 — StorageModule: clientes S3 (interno + presign) e StorageService
- [ ] SI-03.5 — Entidade Video, migration CreateVideos e VideosModule base
- [ ] SI-03.6 — Id público base62 e VideosRepository (unicidade e transições guardadas)
- [ ] SI-03.7 — Exceções de domínio de vídeos e mapeamento no filtro existente
- [ ] SI-03.8 — ChannelsService: resolver o canal do usuário autenticado
- [ ] SI-03.9 — Fila: QueueModule e produtor de jobs de processamento
- [ ] SI-03.10 — Iniciar upload: planejador de partes e VideosService.initiateUpload
- [ ] SI-03.11 — VideosService: URLs por parte e listagem de partes (retomada)
- [ ] SI-03.12 — VideosService: completar (HeadObject, transição e enqueue) e abortar upload
- [ ] SI-03.13 — Endpoint POST /videos (iniciar upload)
- [ ] SI-03.14 — Endpoint POST /videos/:id/upload/part-urls
- [ ] SI-03.15 — Endpoint GET /videos/:id/upload/parts (retomada)
- [ ] SI-03.16 — Endpoint POST /videos/:id/upload/complete
- [ ] SI-03.17 — Endpoint DELETE /videos/:id/upload (abortar)
- [ ] SI-03.18 — Endpoint GET /videos/:id (status do dono)
- [ ] SI-03.19 — Helper de testes: fixtures de vídeo geradas com ffmpeg lavfi
- [ ] SI-03.20 — MediaToolsService: ffprobe e ffmpeg via child_process
- [ ] SI-03.21 — VideoPipelineService: transições de processamento e limpeza para worker e sweeper
- [ ] SI-03.22 — VideoProcessingService: metadados, thumbnail e transição para ready/error
- [ ] SI-03.23 — WorkerModule e VideoProcessingProcessor (retries, backoff e falha final)
- [ ] SI-03.24 — Sweeper: job scheduler de rascunhos vencidos e reconciliação de processing
- [ ] SI-03.25 — Entrypoint worker.ts e serviço video-worker no Compose
- [ ] SI-03.26 — VideoDeliveryService: URLs pré-assinadas de streaming e download
- [ ] SI-03.27 — Endpoint GET /videos/:id/stream (redirect 302 para URL pré-assinada)
- [ ] SI-03.28 — Endpoint GET /videos/:id/download (redirect 302 com Content-Disposition)
- [ ] SI-03.29 — Pipeline ponta a ponta: upload multipart, processamento in-process e streaming
- [ ] SI-03.30 — Regenerar openapi.json com os endpoints de vídeo
- [ ] SI-03.31 — Documentação: CLAUDE.md raiz, nestjs-project/CLAUDE.md, README e diagrama

**Entregas da fase:**

- [ ] Upload de até 10 GiB funcional por multipart com URLs pré-assinadas por parte, com retomada via `ListParts`, sem o arquivo passar pela API
- [ ] Rascunho pré-cadastrado ao iniciar o upload e ciclo de status `draft → processing → ready | error` persistido
- [ ] Processamento automático pelo `video-worker` (duração e metadados via ffprobe, thumbnail JPEG via ffmpeg) com retries/backoff e idempotência
- [ ] URL única por vídeo (id público base62 de 11 caracteres com unique constraint)
- [ ] Streaming (`302` → `206` emitido pelo storage) e download (`Content-Disposition: attachment`) de vídeos `ready`
- [ ] Sweeper (BullMQ job scheduler) aborta uploads abandonados e reenfileira `processing` sem job
- [ ] Compose com `redis` (não publicado, `noeviction` + AOF), `minio` (pgsty/silo), `minio-init` e `video-worker` com autostart; `ffmpeg` na imagem `nestjs-api`
- [ ] Zero dependência do tipo ESM-only nova; `openapi.json` atualizado; `CLAUDE.md` raiz e `nestjs-project/CLAUDE.md` atualizados

**Full test suites** _(rodar com `docker compose stop video-worker`; serviços `db`, `redis`, `minio`, `minio-init` no ar)_:

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`) sem apagar a saída do worker em `dist-worker`
