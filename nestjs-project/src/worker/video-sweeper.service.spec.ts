import { Logger } from '@nestjs/common';
import type { VideoJobsProducer } from '../queue/video-jobs.producer';
import type { VideoPipelineService } from '../videos/video-pipeline.service';
import {
  SWEEP_BATCH_LIMIT,
  VideoSweeperService,
} from './video-sweeper.service';

const STALE_MS = 3600000;
const NOW = new Date('2026-11-06T12:00:00.000Z');

describe('VideoSweeperService', () => {
  let pipeline: jest.Mocked<
    Pick<VideoPipelineService, 'abortExpiredDrafts' | 'findStaleProcessingIds'>
  >;
  let producer: jest.Mocked<Pick<VideoJobsProducer, 'ensureProcessingJob'>>;
  let service: VideoSweeperService;
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    pipeline = {
      abortExpiredDrafts: jest.fn().mockImplementation(() => {
        calls.push('abort');
        return Promise.resolve(2);
      }),
      findStaleProcessingIds: jest.fn().mockImplementation(() => {
        calls.push('find');
        return Promise.resolve(['v1', 'v2']);
      }),
    };
    producer = {
      ensureProcessingJob: jest.fn().mockImplementation(() => {
        calls.push('ensure');
        return Promise.resolve();
      }),
    };
    service = new VideoSweeperService(
      pipeline as unknown as VideoPipelineService,
      producer as unknown as VideoJobsProducer,
      { processingStaleMs: STALE_MS } as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('cleans expired drafts first, then re-enqueues each stale processing video', async () => {
    const result = await service.sweep(NOW);

    expect(calls).toEqual(['abort', 'find', 'ensure', 'ensure']);
    expect(pipeline.abortExpiredDrafts).toHaveBeenCalledWith(
      NOW,
      SWEEP_BATCH_LIMIT,
    );
    expect(pipeline.findStaleProcessingIds).toHaveBeenCalledWith(
      new Date(NOW.getTime() - STALE_MS),
      SWEEP_BATCH_LIMIT,
    );
    expect(producer.ensureProcessingJob).toHaveBeenCalledWith('v1');
    expect(producer.ensureProcessingJob).toHaveBeenCalledWith('v2');
    expect(result).toEqual({ abortedDrafts: 2, requeuedVideos: 2 });
  });

  it('still reconciles processing videos when the draft cleanup fails, and rethrows', async () => {
    pipeline.abortExpiredDrafts.mockRejectedValue(new Error('storage down'));

    await expect(service.sweep(NOW)).rejects.toThrow('storage down');

    expect(producer.ensureProcessingJob).toHaveBeenCalledTimes(2);
  });

  it('still cleans drafts when the reconciliation fails, and rethrows', async () => {
    pipeline.findStaleProcessingIds.mockRejectedValue(new Error('db down'));

    await expect(service.sweep(NOW)).rejects.toThrow('db down');

    expect(pipeline.abortExpiredDrafts).toHaveBeenCalledTimes(1);
    expect(producer.ensureProcessingJob).not.toHaveBeenCalled();
  });

  it('does nothing when there is nothing to sweep', async () => {
    pipeline.abortExpiredDrafts.mockResolvedValue(0);
    pipeline.findStaleProcessingIds.mockResolvedValue([]);

    await expect(service.sweep(NOW)).resolves.toEqual({
      abortedDrafts: 0,
      requeuedVideos: 0,
    });
    expect(producer.ensureProcessingJob).not.toHaveBeenCalled();
  });
});
