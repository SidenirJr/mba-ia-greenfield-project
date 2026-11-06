import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import type { Job, Queue } from 'bullmq';
import { readFile } from 'node:fs/promises';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { Channel } from '../channels/entities/channel.entity';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import { MediaErrorCode } from '../media/media-processing.error';
import {
  processVideoJobId,
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { VideoJobsProducer } from '../queue/video-jobs.producer';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { obliterateQueues, uniqueQueuePrefix } from '../test/queue-test';
import { createTestBucket, type TestBucket } from '../test/storage-test';
import {
  cleanupFixtures,
  generateCorruptFile,
  generateSampleVideo,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/videos.constants';
import { VideosRepository } from '../videos/videos.repository';
import { WorkerModule } from './worker.module';

const POLL_INTERVAL_MS = 50;
const WAIT_TIMEOUT_MS = 20000;
const SHORT_BACKOFF_MS = 50;

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

describe('WorkerModule + VideoProcessingProcessor (integration)', () => {
  const prefix = uniqueQueuePrefix();
  let testBucket: TestBucket;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let queue: Queue;
  let producer: VideoJobsProducer;
  let repository: VideosRepository;
  let storage: StorageService;
  let channel: Channel;
  let counter = 0;

  beforeAll(async () => {
    testBucket = await createTestBucket();
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(storageConfig.KEY)
      .useFactory({
        factory: () => ({ ...storageConfig(), bucket: testBucket.bucket }),
      })
      .overrideProvider(redisConfig.KEY)
      .useFactory({
        factory: () => ({ ...redisConfig(), queuePrefix: prefix }),
      })
      .compile();
    // init() sobe o Worker do BullMQ do @Processor; shutdown (close) o encerra.
    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    producer = moduleRef.get(VideoJobsProducer);
    repository = moduleRef.get(VideosRepository);
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await cleanupFixtures();
    await obliterateQueues(queue);
    await moduleRef.close();
    await testBucket.cleanup();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `worker_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Chan',
      nickname: `workchan${counter}`,
      user_id: user.id,
    });
  });

  async function processingVideo(originalPath?: string): Promise<Video> {
    const video = await repository.createDraft({
      channel_id: channel.id,
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      part_size: 67108864,
      part_count: 1,
      upload_expires_at: new Date(Date.now() + 3600_000),
    });
    await repository.transitionToProcessing(video.id, new Date());
    if (originalPath) {
      await storage.putObject(
        videoOriginalKey(video.id),
        await readFile(originalPath),
        'video/mp4',
      );
    }
    return video;
  }

  const reload = (id: string) =>
    dataSource.getRepository(Video).findOneByOrFail({ id });

  const waitForStatus = (id: string, status: VideoStatus) =>
    waitFor(
      () => reload(id),
      (video) => video.status === status,
    );

  const jobOf = (videoId: string): Promise<Job | undefined> =>
    queue.getJob(processVideoJobId(videoId));

  const waitForJobState = (videoId: string, state: string) =>
    waitFor(
      async () => {
        const job = await jobOf(videoId);
        return { job, state: await job?.getState() };
      },
      (value) => value.state === state,
    );

  it('consumes a job enqueued by the producer and leaves a valid video ready', async () => {
    const video = await processingVideo(
      await generateSampleVideo({ durationSeconds: 2 }),
    );

    await producer.enqueueProcessing(video.id);

    const ready = await waitForStatus(video.id, VideoStatus.READY);
    expect(ready.duration_seconds).toBeCloseTo(2, 1);
    expect(ready.error_code).toBeNull();
    const { job } = await waitForJobState(video.id, 'completed');
    expect(job!.attemptsMade).toBe(1);
  });

  it('fails a corrupt original with a single attempt and records UNREADABLE_MEDIA', async () => {
    const video = await processingVideo(await generateCorruptFile());

    await producer.enqueueProcessing(video.id);

    const failed = await waitForStatus(video.id, VideoStatus.ERROR);
    expect(failed.error_code).toBe(MediaErrorCode.UNREADABLE_MEDIA);
    const { job } = await waitForJobState(video.id, 'failed');
    expect(job!.attemptsMade).toBe(1);
  });

  it('retries a transient failure with exponential backoff and records PROCESSING_FAILED when attempts run out', async () => {
    // Original ausente no storage: o ffprobe recebe 404, falha transitória real em todas as tentativas.
    const video = await processingVideo();
    const startedAt = Date.now();

    await queue.add(
      VIDEO_PROCESS_JOB,
      { videoId: video.id },
      {
        jobId: processVideoJobId(video.id),
        attempts: 3,
        backoff: { type: 'exponential', delay: SHORT_BACKOFF_MS },
      },
    );

    const failed = await waitForStatus(video.id, VideoStatus.ERROR);
    expect(failed.error_code).toBe('PROCESSING_FAILED');
    expect(failed.error_message).not.toContain('X-Amz-Signature');
    const { job } = await waitForJobState(video.id, 'failed');
    expect(job!.attemptsMade).toBe(3);
    // Backoff exponencial de 50 ms: esperas de 50 ms e 100 ms entre as 3 tentativas.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SHORT_BACKOFF_MS * 3);
  });

  it('acks a redelivered job for a video that is already ready without reprocessing', async () => {
    const video = await processingVideo(await generateSampleVideo());
    await producer.enqueueProcessing(video.id);
    const ready = await waitForStatus(video.id, VideoStatus.READY);
    await waitForJobState(video.id, 'completed');

    await producer.ensureProcessingJob(video.id);

    const { job } = await waitForJobState(video.id, 'completed');
    expect(job!.attemptsMade).toBe(1);
    expect(await reload(video.id)).toEqual(ready);
  });

  it('runs one BullMQ worker on video-processing', async () => {
    expect(await queue.getWorkers()).toHaveLength(1);
  });
});

describe('AppModule (integration)', () => {
  it('does not consume video-processing jobs: the API only holds the producer side', async () => {
    const prefix = uniqueQueuePrefix();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(redisConfig.KEY)
      .useFactory({
        factory: () => ({ ...redisConfig(), queuePrefix: prefix }),
      })
      .compile();
    await moduleRef.init();
    const queue: Queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));

    try {
      expect(await queue.getWorkers()).toHaveLength(0);
    } finally {
      await obliterateQueues(queue);
      await moduleRef.close();
    }
  });
});
