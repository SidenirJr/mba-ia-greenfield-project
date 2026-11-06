import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import redisConfig from '../src/config/redis.config';
import storageConfig from '../src/config/storage.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from '../src/queue/queue.constants';
import {
  videoOriginalKey,
  videoThumbnailKey,
} from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { obliterateQueues } from '../src/test/queue-test';
import { requestPresignedUrl } from '../src/test/storage-test';
import {
  createVideosE2eApp,
  E2E_PART_SIZE_BYTES,
  registerConfirmAndLogin,
  type VideosE2eApp,
} from '../src/test/videos-e2e-app';
import {
  cleanupFixtures,
  generateCorruptFile,
  generateMultipartVideo,
} from '../src/test/video-fixtures';
import { Video } from '../src/videos/entities/video.entity';
import { WorkerModule } from '../src/worker/worker.module';

interface VideoBody {
  id: string;
  status: string;
  duration_seconds: number | null;
  bitrate_bps: number | null;
  error_code: string | null;
}

interface UploadedPart {
  part_number: number;
  etag: string;
}

const POLL_INTERVAL_MS = 250;
const PROCESSING_TIMEOUT_MS = 60000;

jest.setTimeout(120000);

describe('video-pipeline', () => {
  let ctx: VideosE2eApp;
  let workerRef: TestingModule;
  let token: string;
  let file: Buffer; // vídeo real de ≥ 6 MiB: 2 partes de 5 MiB
  let corrupt: Buffer;

  const api = () => request(ctx.app.getHttpServer());
  const auth = { Authorization: '' };

  const initiate = async (
    content: Buffer,
    fileName: string,
  ): Promise<string> => {
    const res = await api()
      .post('/videos')
      .set(auth)
      .send({
        file_name: fileName,
        size_bytes: content.length,
        content_type: 'video/mp4',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  // PUT real das partes pedidas (URLs pré-assinadas no storage) e devolve os ETags.
  const uploadParts = async (
    videoId: string,
    content: Buffer,
    partNumbers: number[],
  ): Promise<UploadedPart[]> => {
    const urls = await api()
      .post(`/videos/${videoId}/upload/part-urls`)
      .set(auth)
      .send({ part_numbers: partNumbers })
      .expect(200);
    const parts = (
      urls.body as { parts: { part_number: number; url: string }[] }
    ).parts;
    const uploaded: UploadedPart[] = [];
    for (const { part_number, url } of parts) {
      const start = (part_number - 1) * E2E_PART_SIZE_BYTES;
      const put = await requestPresignedUrl(url, {
        method: 'PUT',
        body: content.subarray(start, start + E2E_PART_SIZE_BYTES),
      });
      expect(put.status).toBe(200);
      uploaded.push({ part_number, etag: put.headers.etag as string });
    }
    return uploaded;
  };

  const complete = (videoId: string, parts: UploadedPart[]) =>
    api()
      .post(`/videos/${videoId}/upload/complete`)
      .set(auth)
      .send({ parts })
      .expect(202);

  // Polling do status pelo endpoint do dono até o worker in-process sair de `processing`.
  const waitForFinalStatus = async (videoId: string): Promise<VideoBody> => {
    const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
    for (;;) {
      const res = await api().get(`/videos/${videoId}`).set(auth).expect(200);
      const body = res.body as VideoBody;
      if (body.status === 'ready' || body.status === 'error') return body;
      if (Date.now() > deadline) {
        throw new Error(`Timed out; last status: ${body.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };

  beforeAll(async () => {
    ctx = await createVideosE2eApp();
    // O worker roda neste processo, na mesma fila e no mesmo bucket da API (o container video-worker deve estar parado).
    workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(storageConfig.KEY)
      .useFactory({
        factory: () => ({
          ...storageConfig(),
          bucket: ctx.testBucket.bucket,
        }),
      })
      .overrideProvider(redisConfig.KEY)
      .useFactory({
        factory: () => ({ ...redisConfig(), queuePrefix: ctx.queuePrefix }),
      })
      .compile();
    await workerRef.init();
    file = await readFile(await generateMultipartVideo());
    corrupt = await readFile(await generateCorruptFile());
  });

  afterAll(async () => {
    await cleanupFixtures();
    await obliterateQueues(
      workerRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)),
      workerRef.get<Queue>(getQueueToken(VIDEO_MAINTENANCE_QUEUE)),
    );
    await workerRef.close();
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    token = await registerConfirmAndLogin(ctx.app, 'owner@example.com');
    auth.Authorization = `Bearer ${token}`;
  });

  // 1. Fluxo completo

  it('uploads-processes-streams-and-downloads-a-video', async () => {
    const videoId = await initiate(file, 'meu video.mp4');
    const parts = await uploadParts(videoId, file, [1, 2]);

    const listed = await api()
      .get(`/videos/${videoId}/upload/parts`)
      .set(auth)
      .expect(200);
    expect(
      (listed.body as { parts: UploadedPart[] }).parts.map((p) => ({
        part_number: p.part_number,
        etag: p.etag,
      })),
    ).toEqual(parts);

    await complete(videoId, parts);
    const final = await waitForFinalStatus(videoId);

    expect(final.status).toBe('ready');
    expect(final.duration_seconds).toBeGreaterThan(0);
    expect(final.bitrate_bps).toBeGreaterThan(0);
    const stored = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: videoId });
    const storage = ctx.moduleRef.get(StorageService);
    expect(
      (await storage.headObject(videoThumbnailKey(stored.id))).contentType,
    ).toBe('image/jpeg');

    const stream = await api().get(`/videos/${videoId}/stream`).redirects(0);
    expect(stream.status).toBe(302);
    const ranged = await requestPresignedUrl(stream.headers.location, {
      range: 'bytes=0-99',
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toMatch(
      new RegExp(`^bytes 0-99/${file.length}$`),
    );

    const download = await api()
      .get(`/videos/${videoId}/download`)
      .redirects(0)
      .expect(302);
    const attachment = await requestPresignedUrl(download.headers.location, {
      range: 'bytes=0-0',
    });
    expect(attachment.headers['content-disposition']).toMatch(
      /^attachment; filename="meu video\.mp4"/,
    );
    expect(
      (await storage.headObject(videoOriginalKey(stored.id))).contentLength,
    ).toBe(file.length);
  });

  // 2. Falha: arquivo que o ffprobe não reconhece

  it('corrupt-file-ends-in-error-and-is-not-streamable', async () => {
    const videoId = await initiate(corrupt, 'corrupt.mp4');
    const parts = await uploadParts(videoId, corrupt, [1]);

    await complete(videoId, parts);
    const final = await waitForFinalStatus(videoId);

    expect(final).toMatchObject({
      status: 'error',
      error_code: 'UNREADABLE_MEDIA',
    });
    const stream = await api().get(`/videos/${videoId}/stream`).redirects(0);
    expect(stream.status).toBe(404);
    expect(stream.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
  });

  // 3. Retomada por ListParts

  it('resumes-an-interrupted-upload-from-listed-parts', async () => {
    const videoId = await initiate(file, 'resumed.mp4');
    const first = await uploadParts(videoId, file, [1]);

    const listed = await api()
      .get(`/videos/${videoId}/upload/parts`)
      .set(auth)
      .expect(200);
    expect(
      (listed.body as { parts: { part_number: number }[] }).parts.map(
        (p) => p.part_number,
      ),
    ).toEqual([1]);

    const second = await uploadParts(videoId, file, [2]);
    await complete(videoId, [...first, ...second]);

    const final = await waitForFinalStatus(videoId);
    expect(final.status).toBe('ready');
  });
});
