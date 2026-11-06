import type { ConfigType } from '@nestjs/config';
import type workerConfig from '../config/worker.config';
import {
  MediaErrorCode,
  MediaProcessingError,
} from '../media/media-processing.error';
import type { MediaToolsService } from '../media/media-tools.service';
import type { MediaProbeResult } from '../media/media.types';
import type { StorageService } from '../storage/storage.service';
import type { VideoPipelineService } from '../videos/video-pipeline.service';
import { VideoStatus } from '../videos/videos.constants';
import { VideoProcessingService } from './video-processing.service';

const probe: MediaProbeResult = {
  durationSeconds: 20,
  width: 640,
  height: 360,
  videoCodec: 'h264',
  containerFormat: 'mp4',
  bitrateBps: 1000,
  metadata: {},
};
const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
const config = { ffmpegTimeoutMs: 600000 } as ConfigType<typeof workerConfig>;

describe('VideoProcessingService', () => {
  let pipeline: {
    getForProcessing: jest.Mock;
    markReady: jest.Mock;
    markError: jest.Mock;
  };
  let storage: { presignInternalGetObject: jest.Mock; putObject: jest.Mock };
  let media: { probe: jest.Mock; extractThumbnail: jest.Mock };
  let service: VideoProcessingService;

  const processing = () =>
    pipeline.getForProcessing.mockResolvedValue({
      id: 'v1',
      status: VideoStatus.PROCESSING,
      content_type: 'video/mp4',
    });

  beforeEach(() => {
    pipeline = {
      getForProcessing: jest.fn(),
      markReady: jest.fn().mockResolvedValue(true),
      markError: jest.fn().mockResolvedValue(true),
    };
    storage = {
      presignInternalGetObject: jest.fn().mockResolvedValue('http://s/url'),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    media = {
      probe: jest.fn().mockResolvedValue(probe),
      extractThumbnail: jest.fn().mockResolvedValue(jpeg),
    };
    service = new VideoProcessingService(
      pipeline as unknown as VideoPipelineService,
      storage as unknown as StorageService,
      media as unknown as MediaToolsService,
      config,
    );
  });

  it.each([
    ['missing', null],
    ['draft', { id: 'v1', status: VideoStatus.DRAFT, content_type: 'v/mp4' }],
    ['ready', { id: 'v1', status: VideoStatus.READY, content_type: 'v/mp4' }],
    ['error', { id: 'v1', status: VideoStatus.ERROR, content_type: 'v/mp4' }],
  ])('returns without any work for a %s video', async (_label, video) => {
    pipeline.getForProcessing.mockResolvedValue(video);

    await service.process('v1');

    expect(storage.presignInternalGetObject).not.toHaveBeenCalled();
    expect(media.probe).not.toHaveBeenCalled();
    expect(pipeline.markReady).not.toHaveBeenCalled();
    expect(pipeline.markError).not.toHaveBeenCalled();
  });

  it('probes, extracts the thumbnail at the probed duration, uploads it and marks ready', async () => {
    processing();

    await service.process('v1');

    expect(storage.presignInternalGetObject).toHaveBeenCalledWith(
      'videos/v1/original',
      expect.any(Number),
    );
    const [, ttl] = storage.presignInternalGetObject.mock.calls[0] as [
      string,
      number,
    ];
    expect(ttl).toBeGreaterThanOrEqual(config.ffmpegTimeoutMs / 1000);
    expect(media.probe).toHaveBeenCalledWith('http://s/url');
    expect(media.extractThumbnail).toHaveBeenCalledWith('http://s/url', 20);
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/v1/thumbnail.jpg',
      jpeg,
      'image/jpeg',
    );
    expect(pipeline.markReady).toHaveBeenCalledWith('v1', probe);
  });

  it.each([MediaErrorCode.UNREADABLE_MEDIA, MediaErrorCode.NO_VIDEO_STREAM])(
    'marks the video as error with %s and rethrows when the probe fails for content reasons',
    async (code) => {
      processing();
      const error = new MediaProcessingError(code, 'bad media', false);
      media.probe.mockRejectedValue(error);

      await expect(service.process('v1')).rejects.toBe(error);

      expect(pipeline.markError).toHaveBeenCalledWith('v1', code, 'bad media');
      expect(media.extractThumbnail).not.toHaveBeenCalled();
      expect(pipeline.markReady).not.toHaveBeenCalled();
    },
  );

  it('marks THUMBNAIL_FAILED, never ready, when the thumbnail fails after the metadata succeeded', async () => {
    processing();
    const error = new MediaProcessingError(
      MediaErrorCode.THUMBNAIL_FAILED,
      'no frame',
      false,
    );
    media.extractThumbnail.mockRejectedValue(error);

    await expect(service.process('v1')).rejects.toBe(error);

    expect(pipeline.markError).toHaveBeenCalledWith(
      'v1',
      MediaErrorCode.THUMBNAIL_FAILED,
      'no frame',
    );
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(pipeline.markReady).not.toHaveBeenCalled();
  });

  it('rethrows a retryable media error without touching the video', async () => {
    processing();
    const error = new MediaProcessingError(
      MediaErrorCode.TRANSIENT,
      'timed out',
      true,
    );
    media.probe.mockRejectedValue(error);

    await expect(service.process('v1')).rejects.toBe(error);

    expect(pipeline.markError).not.toHaveBeenCalled();
  });

  it('rethrows a storage failure while uploading the thumbnail without marking error', async () => {
    processing();
    const error = new Error('storage down');
    storage.putObject.mockRejectedValue(error);

    await expect(service.process('v1')).rejects.toBe(error);

    expect(pipeline.markError).not.toHaveBeenCalled();
    expect(pipeline.markReady).not.toHaveBeenCalled();
  });
});
