import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import workerConfig from '../config/worker.config';
import {
  processVideoJobId,
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
  VIDEO_SWEEPER_SCHEDULER_ID,
} from '../queue/queue.constants';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { obliterateQueues, uniqueQueuePrefix } from '../test/queue-test';
import { createTestBucket, type TestBucket } from '../test/storage-test';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideosRepository } from '../videos/videos.repository';
import { VideoSweeperService } from './video-sweeper.service';
import { WorkerModule } from './worker.module';

const SWEEPER_INTERVAL_MS = 3600000;
const HOUR_MS = 3600000;
const POLL_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 20000;

async function waitFor<T>(
  read: () => Promise<T>,
  isDone: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const value = await read();
    if (isDone(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting; last value: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// Rodar com o serviço `video-worker` do Compose parado: o sweeper dele varreria as linhas criadas aqui.
describe('VideoSweeperService + job scheduler (integration)', () => {
  const prefix = uniqueQueuePrefix();
  let testBucket: TestBucket;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let processingQueue: Queue;
  let maintenanceQueue: Queue;
  let sweeper: VideoSweeperService;
  let repository: VideosRepository;
  let storage: StorageService;
  let channel: Channel;
  let counter = 0;

  const compileWorker = () =>
    Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(storageConfig.KEY)
      .useFactory({
        factory: () => ({ ...storageConfig(), bucket: testBucket.bucket }),
      })
      .overrideProvider(redisConfig.KEY)
      .useFactory({
        factory: () => ({ ...redisConfig(), queuePrefix: prefix }),
      })
      .overrideProvider(workerConfig.KEY)
      .useFactory({
        factory: () => ({
          ...workerConfig(),
          sweeperIntervalMs: SWEEPER_INTERVAL_MS,
          processingStaleMs: HOUR_MS,
        }),
      })
      .compile();

  beforeAll(async () => {
    testBucket = await createTestBucket();
    moduleRef = await compileWorker();
    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    processingQueue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    maintenanceQueue = moduleRef.get(getQueueToken(VIDEO_MAINTENANCE_QUEUE));
    sweeper = moduleRef.get(VideoSweeperService);
    repository = moduleRef.get(VideosRepository);
    storage = moduleRef.get(StorageService);
    // A primeira varredura do scheduler dispara no boot; esperá-la evita que concorra com as linhas dos testes.
    await waitFor(
      () => maintenanceQueue.getJobCounts('completed', 'failed'),
      (counts) => counts.completed + counts.failed >= 1,
    );
    // Pausada: o job re-enfileirado fica `waiting` (estado vivo) em vez de ser consumido pelo worker do módulo.
    await processingQueue.pause();
  });

  afterAll(async () => {
    await processingQueue.resume();
    await obliterateQueues(processingQueue, maintenanceQueue);
    await moduleRef.close();
    await testBucket.cleanup();
  });

  beforeEach(async () => {
    await processingQueue.drain(true);
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `sweeper_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Chan',
      nickname: `sweepchan${counter}`,
      user_id: user.id,
    });
  });

  const newDraft = (upload_expires_at: Date) =>
    repository.createDraft({
      channel_id: channel.id,
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      part_size: 67108864,
      part_count: 1,
      upload_expires_at,
    });

  async function draftWithMultipart(expiresAt: Date): Promise<Video> {
    const video = await newDraft(expiresAt);
    const uploadId = await storage.createMultipartUpload(
      videoOriginalKey(video.id),
      'video/mp4',
    );
    await repository.setUploadId(video.id, uploadId);
    return video;
  }

  const openMultipartKeys = async (): Promise<string[]> => {
    const res = await testBucket.client.send(
      new ListMultipartUploadsCommand({ Bucket: testBucket.bucket }),
    );
    return (res.Uploads ?? []).map((u) => u.Key as string);
  };

  async function staleProcessingVideo(ageMs: number): Promise<Video> {
    const video = await newDraft(new Date(Date.now() + HOUR_MS));
    await repository.transitionToProcessing(
      video.id,
      new Date(Date.now() - ageMs),
    );
    return video;
  }

  const countRows = (id: string) =>
    dataSource.getRepository(Video).countBy({ id });

  it('aborts and deletes an expired draft with a real multipart and keeps a valid draft', async () => {
    const expired = await draftWithMultipart(new Date(Date.now() - 1000));
    const valid = await draftWithMultipart(new Date(Date.now() + HOUR_MS));
    expect(await openMultipartKeys()).toHaveLength(2);

    const result = await sweeper.sweep(new Date());

    expect(result.abortedDrafts).toBe(1);
    expect(await countRows(expired.id)).toBe(0);
    expect(await countRows(valid.id)).toBe(1);
    expect(await openMultipartKeys()).toEqual([videoOriginalKey(valid.id)]);
  });

  it('re-enqueues a stale processing video that has no job', async () => {
    const stale = await staleProcessingVideo(2 * HOUR_MS);
    const fresh = await staleProcessingVideo(1000);

    const result = await sweeper.sweep(new Date());

    expect(result.requeuedVideos).toBe(1);
    const job = await processingQueue.getJob(processVideoJobId(stale.id));
    expect(job?.data).toEqual({ videoId: stale.id });
    expect(await processingQueue.getJob(processVideoJobId(fresh.id))).toBe(
      undefined,
    );
  });

  it('does not duplicate the job of a stale processing video that already has a live one', async () => {
    const stale = await staleProcessingVideo(2 * HOUR_MS);
    await sweeper.sweep(new Date());
    const first = await processingQueue.getJob(processVideoJobId(stale.id));

    await sweeper.sweep(new Date());

    const second = await processingQueue.getJob(processVideoJobId(stale.id));
    expect(second?.timestamp).toBe(first?.timestamp);
    expect(await processingQueue.getJobCounts('waiting')).toEqual({
      waiting: 1,
    });
  });

  it('keeps a single video-sweeper scheduler after the WorkerModule boots twice in a row', async () => {
    const second = await compileWorker();
    await second.init();
    await second.close();

    const schedulers = await maintenanceQueue.getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0].key).toBe(VIDEO_SWEEPER_SCHEDULER_ID);
    expect(schedulers[0].every).toBe(SWEEPER_INTERVAL_MS);
  });
});
