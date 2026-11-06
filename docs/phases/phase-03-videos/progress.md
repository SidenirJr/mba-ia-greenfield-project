# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 30/31 completed

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
- **Status:** completed
- **Tests:** 5 e2e passing em test/videos-initiate-upload.e2e-spec.ts (spec videos-initiate-upload.plan.md, AppModule real com DB, storage e Redis reais); suíte e2e completa 57/57; tsc exit 0; lint exit 0
- **Observations:**
  - Para não duplicar o bootstrap em cada e2e de vídeos (os próximos SIs 03.14-03.18 e 03.27-03.29 usam o mesmo), foram criados os helpers `src/test/videos-e2e-app.ts` (`createVideosE2eApp`: replica `main.ts`, bucket de teste dedicado, prefixo de fila único, `UPLOAD_PART_SIZE_BYTES=5242880`; `reset`/`close`) e `registerConfirmAndLogin` (captura o token de confirmação pelo spy no `MailService`, mesmo padrão do auth.e2e-spec).
  - O arquivo e2e segue o `target_file` do spec (um `describe('videos-initiate-upload')` com um `it` por cenário); o campo `Last sync` dos specs não foi alterado (a skill implement não o manda atualizar).
  - O handler usa `type: InitiateUploadResponseDto` no `@ApiResponse` 201 e `@ApiBearerAuth('access-token')` no nível da classe (todas as rotas do controller, exceto stream/download futuros, são protegidas).

### SI-03.14 — Endpoint POST /videos/:id/upload/part-urls
- **Status:** completed
- **Tests:** 6 e2e passing em test/videos-part-urls.e2e-spec.ts (spec videos-part-urls.plan.md); tsc exit 0; lint exit 0
- **Observations:**
  - `@ApiBearerAuth('access-token')` foi movido do nível da classe para cada handler protegido (regra: handlers `@Public()` futuros, stream/download, não podem carregá-lo); o handler do SI-03.13 foi ajustado na mesma edição, sem mudança de comportamento.
  - O controller passa `dto.part_numbers` ao serviço; o `Last sync` do spec não foi alterado (a skill não manda).

### SI-03.15 — Endpoint GET /videos/:id/upload/parts (retomada)
- **Status:** completed
- **Tests:** 6 e2e passing em test/videos-list-parts.e2e-spec.ts (spec videos-list-parts.plan.md); tsc exit 0; lint exit 0
- **Observations:** 
  - O controller só delega a `listUploadedParts`; o e2e envia 5 MiB reais ao storage por URL pré-assinada e confere o ETag devolvido pelo PUT contra o listado.
  - O `Last sync` do spec não foi alterado (a skill não manda).

### SI-03.16 — Endpoint POST /videos/:id/upload/complete
- **Status:** completed
- **Tests:** 8 e2e passing em test/videos-complete-upload.e2e-spec.ts (spec videos-complete-upload.plan.md); tsc exit 0; lint exit 0
- **Observations:** 
  - **Desvio (dependência de spec):** o spec manda usar `generateMultipartVideo()` (SI-03.19) e `GET /videos/:id` (SI-03.18), ambos posteriores na ordem de execução e fora das dependências declaradas do SI-03.16. O e2e usa um `Buffer` de 6 MiB (o worker não roda nele, o conteúdo não importa); o passo 2 do cenário 1.5 foi alinhado ao spec (GET /videos/:id) no SI-03.18, e a troca pelo `generateMultipartVideo()` foi feita no SI-03.19 (e2e 8/8 mantido).
  - Os PUTs enviam bytes reais ao storage (5 MiB + 1 MiB); o cenário de divergência de tamanho envia 1 KiB a menos que o declarado e verifica `status = error`/`error_code = UPLOAD_SIZE_MISMATCH`.
  - Registrado do SI-03.12 e não alterado: um `complete` concorrente pode virar 400 `INVALID_UPLOAD_PARTS` (NoSuchUpload) em vez de 409, consequência do mapeamento exigido pelo plano.

### SI-03.17 — Endpoint DELETE /videos/:id/upload (abortar)
- **Status:** completed
- **Tests:** 4 e2e passing em test/videos-abort-upload.e2e-spec.ts (spec videos-abort-upload.plan.md); tsc exit 0; lint exit 0
- **Observations:** 
  - **Desvio (dependência de spec):** o passo 2 do cenário 1.1 usa `GET /videos/:id` (SI-03.18, posterior); o e2e foi alinhado ao spec (GET /videos/:id → 404) no SI-03.18.
  - O cenário 1.1 confere no storage real que o `upload_id` anterior falha com `NoSuchUpload` (via `StorageService.listParts`).

### SI-03.18 — Endpoint GET /videos/:id (status do dono)
- **Status:** completed
- **Tests:** 6 e2e passing em test/videos-get-status.e2e-spec.ts; 6 novos em src/videos (unit 3 em videos.service.spec, integration 3 em videos.service.integration-spec); src/videos service specs 57/57; tsc exit 0; lint exit 0
- **Observations:** 
  - O `getOwnedDraft` e o `getOwnedVideo` passaram a compartilhar o privado `findOwned` (resolve canal + busca filtrada por canal + 404), sem mudança de comportamento do primeiro.
  - Os vídeos `ready`/`error` do e2e são semeados com `save` (o `insert` do TypeORM não aceita o objeto jsonb `metadata` no tipo).
  - Alinhei os e2e dos SIs 03.16 (cenário 1.5) e 03.17 (cenário 1.1) ao spec, passando a usar `GET /videos/:id` agora que ele existe; `test/videos-*` 35/35.

### SI-03.19 — Helper de testes: fixtures de vídeo geradas com ffmpeg lavfi
- **Status:** completed
- **Tests:** 5 novos passing em src/test/video-fixtures.integration-spec.ts (ffmpeg/ffprobe reais); e2e videos-complete-upload 8/8 com a fixture real; tsc exit 0; lint exit 0
- **Observations:** 
  - Fixtures em `os.tmpdir()` (`mkdtemp`), removidas por `cleanupFixtures()`; nenhum binário entra no repositório (`git status` limpo após o spec).
  - `generateSampleVideo` aceita `durationSeconds`/`faststart`/`minBytes`; com `minBytes` usa `testsrc2` 640x360 com filtro `noise` (incompressível, ~3 MB/s em libx264 crf 23) e realonga a duração até atingir o mínimo (comentário `shortcut:`). `generateMultipartVideo()` fica entre 6 e 10 MiB (2 partes de 5 MiB), verificado no spec.
  - O não-faststart é o padrão do muxer mp4 (moov no fim); o spec percorre os átomos de topo para provar a ordem moov/mdat. Áudio-only: AAC em mp4 via `sine`; corrompido: 4 KiB de bytes aleatórios.
  - O e2e do SI-03.16 passou a usar `generateMultipartVideo()` (alinhamento com o spec).

### SI-03.20 — MediaToolsService: ffprobe e ffmpeg via child_process
- **Status:** completed
- **Tests:** 28 novos passing (media-probe.mapper.spec 18 unit, media-tools.service.integration-spec 10 com ffmpeg/ffprobe e storage reais); tsc exit 0; lint exit 0
- **Observations:**
  - Sem `fluent-ffmpeg`: `execFile` direto com `FFMPEG_TIMEOUT_MS` (SIGKILL no timeout, tratado como TRANSIENT retryable); o erro cru do `execFile` nunca é propagado (traz a linha de comando com a URL assinada), só o stderr sanitizado (`[redacted-url]`).
  - Classificação por regex no stderr (comentário `shortcut:`): dados inválidos (`Invalid data found`, `moov atom not found` etc.) → não-retryable (`UNREADABLE_MEDIA` no probe, `THUMBNAIL_FAILED` na thumbnail); qualquer outra falha (HTTP 4xx/5xx, conexão, I/O, timeout, binário ausente) → `TRANSIENT` retryable (limitado pelas 3 tentativas do BullMQ). Duração ausente/inválida → `UNREADABLE_MEDIA` (ready exige duração).
  - Thumbnail: um seek exatamente no fim da mídia (vídeo de 0,5 s: `min(max(0.05,1),0.5)=0.5`) não decodifica frame; `extractThumbnail` refaz em t=0 antes de falhar com `THUMBNAIL_FAILED` (`thumbnailSeekSeconds` segue exatamente a fórmula do plano).
  - O `metadata` guarda `{ format, streams[] }` aparado por allow-list de chaves, sem `format.filename` e com varredura final de URLs; o timeout é testado com servidor HTTP local que nunca responde (determinístico).

### SI-03.21 — VideoPipelineService: transições de processamento e limpeza para worker e sweeper
- **Status:** completed
- **Tests:** 20 novos passing (video-pipeline.service.spec 10, video-pipeline.service.integration-spec 10 com DB e storage reais); videos.module.spec 1/1; tsc exit 0; lint exit 0
- **Observations:**
  - `markReady`/`markError` devolvem `boolean` (houve efeito); `getForProcessing` devolve só `id`, `status` e `content_type` (nunca o `upload_id`).
  - `abortExpiredDrafts` isola cada rascunho (contexto de background): `NoSuchUpload` é tolerado (a linha é apagada mesmo assim — duplica a tolerância do `StorageService`, de propósito, porque o spec do plano exige o comportamento no pipeline), qualquer outra falha vira log `warn`, mantém a linha para a próxima varredura e não impede os demais; rascunho sem `upload_id` pula o abort. A contagem retornada é de linhas realmente removidas.
  - `VideosModule` registra e exporta `VideoPipelineService`; sem mudança nos specs existentes.

### SI-03.22 — VideoProcessingService: metadados, thumbnail e transição para ready/error
- **Status:** completed
- **Tests:** 18 novos passing (video-processing.service.spec 10, video-processing.service.integration-spec 8 com DB, storage e ffmpeg reais); src/media + src/test regressão 35/35 (+2 casos no classificador); tsc exit 0; lint exit 0
- **Observations:**
  - **Flakiness achada e corrigida (fixture do SI-03.19):** `generateCorruptFile` usava 4 KiB aleatórios; em ~metade das execuções o ffprobe os detecta como stream MP3 e, lido por HTTP, falha com `Failed to read frame size: Could not seek` em vez de `Invalid data found`, o que o classificador tratava como TRANSIENT. Correção: o fixture passou a ser texto fixo (determinístico, ffprobe sempre responde `Invalid data found`) e o classificador do SI-03.20 ganhou os padrões `invalid frame size`/`failed to read frame size`/`header missing` (mídia que o demuxer aceita e depois rejeita), com 2 casos novos no unit. 8 execuções seguidas estáveis.
  - Falha do `putObject` da thumbnail (storage inacessível) é tratada como transitória: propaga o erro cru, vídeo permanece `processing` (o catálogo diz "frame extraction/upload fails", mas o plano exige que storage inacessível seja retryable e `THUMBNAIL_FAILED` só para falha de extração do ffmpeg).
  - TTL da URL interna = `ceil(FFMPEG_TIMEOUT_MS/1000) * 2 + 60` s (probe e thumbnail, cada um até o timeout, mais folga), sempre ≥ `FFMPEG_TIMEOUT_MS`.
  - `VideoProcessingService` só conhece `VideoPipelineService` (nunca o repositório); o spec de integração monta o módulo com `VideosModule`, `StorageModule` e `MediaModule` (o `WorkerModule` do SI-03.23 importará os mesmos).

### SI-03.23 — WorkerModule e VideoProcessingProcessor (retries, backoff e falha final)
- **Status:** completed
- **Tests:** 17 novos passing (video-processing.processor.spec 11 unit; video-processing.processor.integration-spec 6 com WorkerModule in-process e Redis/DB/storage/ffmpeg reais, 4 execuções seguidas estáveis); app.e2e 1/1; tsc exit 0; lint exit 0
- **Observations:**
  - `@Processor` só existe em `VideoProcessingProcessor` provido no `WorkerModule`; o spec de integração prova que o `AppModule` sobe com 0 consumidores em `video-processing` (`queue.getWorkers()`), enquanto o `WorkerModule` sobe com 1.
  - **Extração (consequência de "mesmos namespaces e Joi do AppModule"):** a configuração do `ConfigModule` e do `TypeOrmModule.forRootAsync` foi movida para `src/config/infra-module-options.ts` e é usada por `AppModule` e `WorkerModule` para os dois processos não divergirem; sem mudança de comportamento no `AppModule` (app.e2e 1/1).
  - Retries e falha final testados de verdade: original ausente no storage faz o ffprobe receber 404 (TRANSIENT real); o job é enfileirado com `attempts: 3` e backoff exponencial de 50 ms só nesse teste (o default de 30 s do `QueueModule` não muda), `attemptsMade = 3` e vídeo `error`/`PROCESSING_FAILED`. Corrompido: `attemptsMade = 1`, vídeo `UNREADABLE_MEDIA` (o handler `failed` também dispara por `UnrecoverableError`, mas `markError` é guardado e não sobrescreve o código de conteúdo).
  - O handler `failed` captura e loga falha do `markError` (contexto de background; o sweeper do SI-03.24 reenfileira o `processing` esquecido). Mensagem gravada passa por `sanitizeSignedUrls`.
  - Concurrency do worker fica no default do BullMQ (1); o plano não define outro valor. O entrypoint `src/worker.ts`/shutdown hooks e o serviço Compose são do SI-03.25.

### SI-03.24 — Sweeper: job scheduler de rascunhos vencidos e reconciliação de processing
- **Status:** completed
- **Tests:** 8 novos passing (video-sweeper.service.spec 4 unit; video-sweeper.service.integration-spec 4 com WorkerModule in-process e Redis/DB/storage reais, 3 execuções seguidas estáveis); src/worker 43/43; tsc exit 0; lint exit 0
- **Observations:**
  - **Bug do SI-03.23 achado e corrigido:** `WorkerModule` sozinho (sem `AppModule`) falhava ao conectar (`Entity metadata for Channel#user was not found`) porque ninguém registrava `User`; o spec do processor passou porque importa o `AppModule`. Corrigido com `TypeOrmModule.forFeature([User])` no `WorkerModule`; o spec novo importa só o `WorkerModule` e cobre a regressão.
  - `sweep(now)` roda as duas etapas de forma independente (falha de uma não impede a outra) e relança o primeiro erro no fim, para o retry do job (`attempts: 3`, `backoff: 3000`, `removeOnFail: 1000`); lote fixo `SWEEP_BATCH_LIMIT = 100` por varredura (comentário `shortcut:`; o plano não define o limite).
  - O scheduler `video-sweeper` é registrado em `WorkerModule.onModuleInit` com `upsertJobScheduler` (conferido no context7 `/taskforcesh/bullmq`); a primeira varredura dispara no boot, por isso o spec espera esse job antes de semear linhas e pausa a fila `video-processing` para o job re-enfileirado ficar `waiting` (vivo) sem ser consumido.
  - O spec cobre `ensureProcessingJob` com job vivo (sem duplicar); o ramo de registro `failed`/`completed` já é coberto no spec do produtor (SI-03.9).

### SI-03.25 — Entrypoint worker.ts e serviço video-worker no Compose
- **Status:** completed
- **Tests:** no tests (infra/entrypoint, conforme o plano); validação manual no Compose: `docker compose up -d video-worker` sobe depois de db/redis/minio saudáveis e minio-init concluído, sem portas publicadas; um vídeo real (fixture ffmpeg enviada ao storage, `processing`, job enfileirado) foi consumido pelo container e virou `ready` com `duration_seconds` preenchido; `npm run build` da API não apaga `dist-worker` (e `dist` segue intacto); `docker compose stop` encerra sem erro; tsc exit 0; lint exit 0
- **Observations:**
  - **Ajuste ao plano:** o `tsconfig.worker.json` (outDir `dist-worker`) precisou de `exclude` próprio com `dist-worker`, e o `tsconfig.build.json` também passou a excluí-lo; sem isso o `tsc` do worker lia os `.d.ts` gerados na própria saída (`TS5055 ... would overwrite input file`, 94 erros) e a API poderia fazer o mesmo no `build`/`start:dev`.
  - Shutdown: o nest CLI em watch repassa o SIGTERM e o `docker compose stop` mostra `npm error signal SIGTERM` com exit code 1 do `npm run` (ruído do npm/nest CLI no `--watch`); rodando `node dist-worker/worker` direto, o SIGTERM encerra sem erro nos logs (exit 143, o Nest re-emite o sinal após os shutdown hooks) e sem cliente Redis remanescente.
  - O script de validação temporário (criava usuário, canal e vídeo no banco de dev) foi removido e as linhas apagadas; sobrou 1 objeto de fixture `videos/<uuid>/original` e a thumbnail no bucket de dev.
  - `start:dev` não foi iniciado (regra do projeto); a ausência de conflito foi verificada pelo `build` e pelo `exclude`.

### SI-03.26 — VideoDeliveryService: URLs pré-assinadas de streaming e download
- **Status:** completed
- **Tests:** 21 novos passing (content-disposition.util.spec 6, video-delivery.service.spec 6 com `it.each`, video-delivery.service.integration-spec 9 com DB e storage reais); videos.module.spec 1/1; tsc exit 0; lint exit 0
- **Observations:**
  - A integração segue a URL pré-assinada de verdade com `requestPresignedUrl` (host override, helper do spike do SI-03.1): `200` com `Content-Type` do vídeo mesmo com o objeto salvo como `octet-stream` (prova do `ResponseContentType`), `206` com `Content-Range: bytes 0-99/1000` e `Accept-Ranges: bytes`, e `Content-Disposition: attachment` emitido pelo storage; o nome malicioso (aspas, CRLF) vira header sem essas sequências e sem header injetado.
  - `buildAttachmentDisposition` também remove controles Unicode e surrogates solitários (que fariam `encodeURIComponent` lançar `URIError`), codifica `' ( ) *` no `filename*` (RFC 5987) e cai no nome `video` se nada utilizável restar (o plano não define o fallback).
  - O stream também força `ResponseContentType` (TD-08); o download usa o mesmo `content_type` além do `Content-Disposition`.

### SI-03.27 — Endpoint GET /videos/:id/stream (redirect 302 para URL pré-assinada)
- **Status:** completed
- **Tests:** 3 e2e passing em test/videos-stream.e2e-spec.ts (spec videos-stream.plan.md, AppModule real com DB e storage reais); tsc exit 0; lint exit 0
- **Observations:**
  - O cenário do `206` segue o `Location` de verdade com `requestPresignedUrl` (host override do spike do SI-03.1): `Content-Range: bytes 0-99/...`, `Accept-Ranges` e `Content-Type: video/mp4` vêm do storage; a API só responde o `302` (`@Public()` + `@Redirect()` devolvendo `{ url, statusCode }`).
  - Os vídeos `ready` são semeados por insert + objeto real (`generateSampleVideo`) no bucket de teste; `draft`/`processing`/`error` por insert direto. O `Last sync` do spec não foi alterado (a skill não manda).
  - `VideosController` ganhou a injeção de `VideoDeliveryService`; o `@ApiBearerAuth` não aparece nesta rota (o decorator já era por handler desde o SI-03.14).

### SI-03.28 — Endpoint GET /videos/:id/download (redirect 302 com Content-Disposition)
- **Status:** completed
- **Tests:** 3 e2e passing em test/videos-download.e2e-spec.ts (spec videos-download.plan.md, AppModule real com DB e storage reais); tsc exit 0; lint exit 0
- **Observations:**
  - O cenário 1.2 segue o `Location` de verdade com `requestPresignedUrl` (host override): `200` com `Content-Disposition: attachment; filename="meu video.mp4"` emitido pelo storage; a API só responde o `302` (`@Public()` + `@Redirect()`).
  - O `Last sync` do spec não foi alterado (a skill não manda).

### SI-03.29 — Pipeline ponta a ponta: upload multipart, processamento in-process e streaming
- **Status:** completed
- **Tests:** 3 e2e passing em test/video-pipeline.e2e-spec.ts (AppModule + WorkerModule in-process; DB, Redis, storage e ffmpeg reais; 3 execuções seguidas estáveis, com `video-worker` parado); tsc exit 0; lint exit 0
- **Observations:**
  - O `AppModule` (via `createVideosE2eApp`) e o `WorkerModule` sobem como dois `TestingModule` no mesmo processo, compartilhando bucket de teste e prefixo de fila; para isso o helper passou a expor `queuePrefix`. Dois módulos (e não um com os dois) evitam duplicar `ConfigModule`/`TypeOrmModule.forRoot` no mesmo contexto.
  - Cenários: fluxo completo (PUT real de 2 partes, `upload/parts`, `complete`, polling até `ready`, `duration_seconds`/`bitrate_bps`, thumbnail `image/jpeg` no storage, stream `302` + `Range` `206` com `Content-Range` total, download com `Content-Disposition`), corrompido (`error`/`UNREADABLE_MEDIA`, stream `404`) e retomada (parte 1, `ListParts`, parte 2, `complete`, `ready`).
  - O `afterAll` faz `obliterate` das filas de processamento e manutenção (scheduler do sweeper) e remove o bucket de teste; `cleanAllTables` já limpava `videos`.
  - O sweeper do `WorkerModule` in-process usa a fila de manutenção do prefixo exclusivo, sem interferir no `video-worker` do Compose (que deve ficar parado por causa do banco compartilhado).

### SI-03.30 — Regenerar openapi.json com os endpoints de vídeo
- **Status:** completed
- **Tests:** 1 novo e2e passing em test/swagger.e2e-spec.ts (7/7 no arquivo); `openapi:export` rodado duas vezes sem diff (idempotente); tsc exit 0; lint exit 0
- **Observations:**
  - O openapi.json ganhou as oito rotas de `/videos` (tag `videos`) e os schemas `InitiateUploadDto`, `InitiateUploadResponseDto`, `PartUrlsDto`/`PartUrlsResponseDto`, `UploadedPartsResponseDto`, `CompleteUploadDto` e `VideoResponseDto`; os erros referenciam `ApiErrorEnvelope`.
  - O `createApp` do `swagger.e2e-spec.ts` passou a usar `buildSwaggerDocument(app)` (o mesmo de `main.ts` e do export, com `extraModels: [ApiErrorEnvelope]`) em vez de `createDocument` direto, senão o `ApiErrorEnvelope` não entra em `components.schemas` no teste; os demais testes do arquivo seguem verdes.

### SI-03.31 — Documentação: CLAUDE.md raiz, nestjs-project/CLAUDE.md, README e diagrama
- **Status:** pending
- **Tests:** pending
- **Observations:** none
