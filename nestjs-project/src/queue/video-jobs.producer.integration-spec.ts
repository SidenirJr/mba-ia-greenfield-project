import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import redisConfig from '../config/redis.config';
import { obliterateQueues, uniqueQueuePrefix } from '../test/queue-test';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
  processVideoJobId,
} from './queue.constants';
import { QueueModule } from './queue.module';
import { VideoJobsProducer } from './video-jobs.producer';

describe('VideoJobsProducer (integration)', () => {
  const prefix = uniqueQueuePrefix();
  let moduleRef: TestingModule;
  let producer: VideoJobsProducer;
  let processingQueue: Queue;
  let maintenanceQueue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [redisConfig] }),
        QueueModule,
      ],
    })
      .overrideProvider(redisConfig.KEY)
      .useFactory({
        factory: () => ({ ...redisConfig(), queuePrefix: prefix }),
      })
      .compile();
    await moduleRef.init();
    producer = moduleRef.get(VideoJobsProducer);
    processingQueue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    maintenanceQueue = moduleRef.get(getQueueToken(VIDEO_MAINTENANCE_QUEUE));
  });

  beforeEach(async () => {
    await obliterateQueues(processingQueue, maintenanceQueue);
  });

  afterAll(async () => {
    await obliterateQueues(processingQueue, maintenanceQueue);
    await moduleRef.close();
  });

  // Worker temporário só para levar o job a failed/completed; o módulo em si não tem consumidor.
  async function settleJob(outcome: 'failed' | 'completed'): Promise<void> {
    const worker = new Worker(
      VIDEO_PROCESSING_QUEUE,
      () => {
        if (outcome === 'failed') throw new UnrecoverableError('boom');
        return Promise.resolve();
      },
      {
        connection: { host: redisConfig().host, port: redisConfig().port },
        prefix,
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        worker.on(outcome, () => resolve());
        worker.on('error', reject);
      });
    } finally {
      await worker.close();
    }
  }

  it('boots bullmq 6 against the installed ioredis and connects to redis by service name with the configured prefix', async () => {
    expect(processingQueue.opts.connection).toMatchObject({
      host: 'redis',
      port: 6379,
    });
    // Round trip real no Redis do Compose.
    expect((await processingQueue.getJobCounts('waiting')).waiting).toBe(0);
    expect(processingQueue.opts.prefix).toBe(prefix);
    expect(maintenanceQueue.opts.prefix).toBe(prefix);
  });

  it('creates the job with the deterministic dash id, attempts 3 and exponential backoff of 30000 ms', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);

    const job = await processingQueue.getJob(`process-video-${videoId}`);
    expect(job).toBeDefined();
    expect(job!.id).toBe(processVideoJobId(videoId));
    expect(job!.name).toBe(VIDEO_PROCESS_JOB);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toMatchObject({
      type: 'exponential',
      delay: 30000,
    });
  });

  it('rejects a custom jobId containing a colon, which is why the id uses a dash', async () => {
    await expect(
      processingQueue.add(
        VIDEO_PROCESS_JOB,
        { videoId: 'x' },
        { jobId: 'process-video:x' },
      ),
    ).rejects.toThrow(/Custom Id cannot contain/);
  });

  it('keeps a single job when enqueueProcessing is called twice for the same video', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);
    await producer.enqueueProcessing(videoId);

    const counts = await processingQueue.getJobCounts('waiting', 'delayed');
    expect(counts.waiting + counts.delayed).toBe(1);
  });

  it('ensureProcessingJob does not duplicate a waiting job', async () => {
    const videoId = randomUUID();
    await producer.enqueueProcessing(videoId);
    const before = await processingQueue.getJob(processVideoJobId(videoId));

    await producer.ensureProcessingJob(videoId);

    const after = await processingQueue.getJob(processVideoJobId(videoId));
    expect(await after!.getState()).toBe('waiting');
    expect(after!.timestamp).toBe(before!.timestamp);
    expect((await processingQueue.getJobCounts('waiting')).waiting).toBe(1);
  });

  it('ensureProcessingJob creates the job when none exists', async () => {
    const videoId = randomUUID();

    await producer.ensureProcessingJob(videoId);

    const job = await processingQueue.getJob(processVideoJobId(videoId));
    expect(await job!.getState()).toBe('waiting');
  });

  it.each(['failed', 'completed'] as const)(
    'ensureProcessingJob replaces a %s job of the same video with a new waiting job',
    async (outcome) => {
      const videoId = randomUUID();
      await producer.enqueueProcessing(videoId);
      await settleJob(outcome);
      const settled = await processingQueue.getJob(processVideoJobId(videoId));
      expect(await settled!.getState()).toBe(outcome);

      await producer.ensureProcessingJob(videoId);

      const job = await processingQueue.getJob(processVideoJobId(videoId));
      expect(await job!.getState()).toBe('waiting');
      const counts = await processingQueue.getJobCounts(
        'waiting',
        'failed',
        'completed',
      );
      expect(counts).toMatchObject({ waiting: 1, failed: 0, completed: 0 });
    },
  );

  it('does not start any consumer for video-processing when only the producer module is loaded', async () => {
    expect(await processingQueue.getWorkers()).toHaveLength(0);
  });
});
