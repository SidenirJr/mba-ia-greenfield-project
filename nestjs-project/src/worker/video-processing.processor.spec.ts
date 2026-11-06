import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import {
  MediaErrorCode,
  MediaProcessingError,
} from '../media/media-processing.error';
import type { VideoPipelineService } from '../videos/video-pipeline.service';
import {
  VideoProcessingProcessor,
  type VideoProcessingJobData,
} from './video-processing.processor';
import type { VideoProcessingService } from './video-processing.service';

const SIGNED_URL = 'http://minio:9000/b/k?X-Amz-Signature=deadbeef';

const jobOf = (attemptsMade: number, attempts = 3) =>
  ({
    data: { videoId: 'v1' },
    attemptsMade,
    opts: { attempts },
  }) as unknown as Job<VideoProcessingJobData>;

describe('VideoProcessingProcessor', () => {
  let processing: { process: jest.Mock };
  let pipeline: { markError: jest.Mock };
  let processor: VideoProcessingProcessor;
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    processing = { process: jest.fn().mockResolvedValue(undefined) };
    pipeline = { markError: jest.fn().mockResolvedValue(true) };
    processor = new VideoProcessingProcessor(
      processing as unknown as VideoProcessingService,
      pipeline as unknown as VideoPipelineService,
    );
  });

  describe('process', () => {
    it('delegates the video id of the job to the processing service', async () => {
      await processor.process(jobOf(0));

      expect(processing.process).toHaveBeenCalledWith('v1');
    });

    it.each([MediaErrorCode.UNREADABLE_MEDIA, MediaErrorCode.NO_VIDEO_STREAM])(
      'turns a non-retryable %s into an UnrecoverableError',
      async (code) => {
        processing.process.mockRejectedValue(
          new MediaProcessingError(code, 'bad media', false),
        );

        const error = await processor
          .process(jobOf(0))
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(UnrecoverableError);
        expect((error as Error).message).toBe('bad media');
      },
    );

    it('rethrows a retryable media error untouched so BullMQ retries with backoff', async () => {
      const error = new MediaProcessingError(
        MediaErrorCode.TRANSIENT,
        'timed out',
        true,
      );
      processing.process.mockRejectedValue(error);

      await expect(processor.process(jobOf(0))).rejects.toBe(error);
    });

    it('rethrows any other error untouched', async () => {
      const error = new Error('storage down');
      processing.process.mockRejectedValue(error);

      await expect(processor.process(jobOf(0))).rejects.toBe(error);
    });
  });

  describe('failed handler', () => {
    it('does not mark the video while attempts remain', async () => {
      await processor.onFailed(jobOf(1), new Error('transient'));
      await processor.onFailed(jobOf(2), new Error('transient'));

      expect(pipeline.markError).not.toHaveBeenCalled();
    });

    it('marks PROCESSING_FAILED with a sanitized message on the last attempt', async () => {
      await processor.onFailed(jobOf(3), new Error(`failed ${SIGNED_URL}`));

      expect(pipeline.markError).toHaveBeenCalledWith(
        'v1',
        'PROCESSING_FAILED',
        'failed [redacted-url]',
      );
    });

    it('marks right away on an UnrecoverableError even with attempts remaining', async () => {
      await processor.onFailed(jobOf(1), new UnrecoverableError('bad media'));

      expect(pipeline.markError).toHaveBeenCalledWith(
        'v1',
        'PROCESSING_FAILED',
        'bad media',
      );
    });

    it('treats a job without configured attempts as a single attempt', async () => {
      const job = jobOf(1);
      job.opts.attempts = undefined;

      await processor.onFailed(job, new Error('boom'));

      expect(pipeline.markError).toHaveBeenCalledTimes(1);
    });

    it('ignores an event without job', async () => {
      await processor.onFailed(undefined, new Error('boom'));

      expect(pipeline.markError).not.toHaveBeenCalled();
    });

    it('logs and does not throw when recording the failure fails', async () => {
      pipeline.markError.mockRejectedValue(new Error('db down'));

      await expect(
        processor.onFailed(jobOf(3), new Error('boom')),
      ).resolves.toBeUndefined();

      expect(logError).toHaveBeenCalledWith(expect.stringContaining('db down'));
    });
  });
});
