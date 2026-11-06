import { Logger } from '@nestjs/common';
import type { MediaProbeResult } from '../media/media.types';
import type { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoPipelineService } from './video-pipeline.service';
import { VideoStatus } from './videos.constants';
import type { VideosRepository } from './videos.repository';

const probe: MediaProbeResult = {
  durationSeconds: 12.5,
  width: 640,
  height: 360,
  videoCodec: 'h264',
  containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
  bitrateBps: 800000,
  metadata: { format: {}, streams: [] },
};

describe('VideoPipelineService', () => {
  let repository: {
    findById: jest.Mock;
    markReady: jest.Mock;
    markError: jest.Mock;
    findExpiredDrafts: jest.Mock;
    deleteDraft: jest.Mock;
    findStaleProcessing: jest.Mock;
  };
  let storage: { abortMultipartUpload: jest.Mock };
  let service: VideoPipelineService;

  const draft = (id: string, uploadId: string | null = `upload-${id}`) =>
    ({ id, upload_id: uploadId }) as Video;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    repository = {
      findById: jest.fn(),
      markReady: jest.fn(),
      markError: jest.fn(),
      findExpiredDrafts: jest.fn(),
      deleteDraft: jest.fn().mockResolvedValue(1),
      findStaleProcessing: jest.fn(),
    };
    storage = { abortMultipartUpload: jest.fn().mockResolvedValue(undefined) };
    service = new VideoPipelineService(
      repository as unknown as VideosRepository,
      storage as unknown as StorageService,
    );
  });

  describe('getForProcessing', () => {
    it('returns only id, status and content type', async () => {
      repository.findById.mockResolvedValue({
        id: 'v1',
        status: VideoStatus.PROCESSING,
        content_type: 'video/mp4',
        upload_id: 'secret',
      });

      await expect(service.getForProcessing('v1')).resolves.toEqual({
        id: 'v1',
        status: VideoStatus.PROCESSING,
        content_type: 'video/mp4',
      });
    });

    it('returns null for an unknown id', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.getForProcessing('nope')).resolves.toBeNull();
    });
  });

  describe('markReady', () => {
    it('maps the probe to the ready columns and reports the effect', async () => {
      repository.markReady.mockResolvedValue(1);

      await expect(service.markReady('v1', probe)).resolves.toBe(true);

      expect(repository.markReady).toHaveBeenCalledWith('v1', {
        duration_seconds: 12.5,
        width: 640,
        height: 360,
        video_codec: 'h264',
        container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitrate_bps: 800000,
        metadata: { format: {}, streams: [] },
      });
    });

    it('reports no effect when the guarded update affected nothing', async () => {
      repository.markReady.mockResolvedValue(0);

      await expect(service.markReady('v1', probe)).resolves.toBe(false);
    });
  });

  describe('markError', () => {
    it('reports the effect of the guarded update', async () => {
      repository.markError.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

      await expect(service.markError('v1', 'CODE', 'msg')).resolves.toBe(true);
      await expect(service.markError('v1', 'CODE', 'msg')).resolves.toBe(false);
      expect(repository.markError).toHaveBeenCalledWith('v1', 'CODE', 'msg');
    });
  });

  describe('abortExpiredDrafts', () => {
    const now = new Date();

    it('aborts the multipart of the original key and deletes every expired draft', async () => {
      repository.findExpiredDrafts.mockResolvedValue([draft('a'), draft('b')]);

      await expect(service.abortExpiredDrafts(now, 10)).resolves.toBe(2);

      expect(repository.findExpiredDrafts).toHaveBeenCalledWith(now, 10);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/a/original',
        'upload-a',
      );
      expect(repository.deleteDraft).toHaveBeenCalledWith('b');
    });

    it('continues and deletes the row when the multipart no longer exists', async () => {
      repository.findExpiredDrafts.mockResolvedValue([draft('a'), draft('b')]);
      storage.abortMultipartUpload.mockRejectedValueOnce(
        Object.assign(new Error('gone'), { name: 'NoSuchUpload' }),
      );

      await expect(service.abortExpiredDrafts(now, 10)).resolves.toBe(2);

      expect(repository.deleteDraft).toHaveBeenCalledTimes(2);
    });

    it('skips the abort for a draft without upload id but still deletes it', async () => {
      repository.findExpiredDrafts.mockResolvedValue([draft('a', null)]);

      await expect(service.abortExpiredDrafts(now, 10)).resolves.toBe(1);

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('logs and keeps the row of a draft whose abort fails, cleaning the others', async () => {
      repository.findExpiredDrafts.mockResolvedValue([draft('a'), draft('b')]);
      storage.abortMultipartUpload.mockRejectedValueOnce(new Error('s3 down'));

      await expect(service.abortExpiredDrafts(now, 10)).resolves.toBe(1);

      expect(repository.deleteDraft).toHaveBeenCalledTimes(1);
      expect(repository.deleteDraft).toHaveBeenCalledWith('b');
    });
  });

  describe('findStaleProcessingIds', () => {
    it('returns the ids found by the repository', async () => {
      const olderThan = new Date();
      repository.findStaleProcessing.mockResolvedValue([
        { id: 'a' },
        { id: 'b' },
      ]);

      await expect(
        service.findStaleProcessingIds(olderThan, 5),
      ).resolves.toEqual(['a', 'b']);
      expect(repository.findStaleProcessing).toHaveBeenCalledWith(olderThan, 5);
    });
  });
});
