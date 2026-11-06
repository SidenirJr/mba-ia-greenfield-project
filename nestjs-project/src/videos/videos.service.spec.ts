import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidContentTypeException,
  InvalidPartNumberException,
  InvalidUploadPartsException,
  UploadExpiredException,
  UploadSizeExceedsLimitException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';
import type { VideoJobsProducer } from '../queue/video-jobs.producer';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.constants';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

const config = {
  maxBytes: 10737418240,
  partSizeBytes: 67108864,
  expirationHours: 24,
};
const storageSettings = { presignExpiresSeconds: 900 };

describe('VideosService', () => {
  let repository: {
    createDraft: jest.Mock;
    setUploadId: jest.Mock;
    deleteDraft: jest.Mock;
    findOwnedByPublicId: jest.Mock;
    findById: jest.Mock;
    markDraftError: jest.Mock;
    transitionToProcessing: jest.Mock;
  };
  let producer: { enqueueProcessing: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    listParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let channels: { getByUserId: jest.Mock };
  let service: VideosService;

  const dto = {
    file_name: 'clip.mp4',
    size_bytes: 1024,
    content_type: 'video/mp4',
  };

  beforeEach(() => {
    repository = {
      createDraft: jest.fn().mockResolvedValue({
        id: 'video-uuid',
        public_id: 'abcdefghijk',
        status: VideoStatus.DRAFT,
      } as Video),
      setUploadId: jest.fn().mockResolvedValue(undefined),
      deleteDraft: jest.fn().mockResolvedValue(1),
      findOwnedByPublicId: jest.fn().mockResolvedValue(null),
      findById: jest.fn(),
      markDraftError: jest.fn().mockResolvedValue(1),
      transitionToProcessing: jest.fn().mockResolvedValue(1),
    };
    producer = { enqueueProcessing: jest.fn().mockResolvedValue(undefined) };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('up-1'),
      presignUploadPart: jest.fn(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`https://storage/part-${partNumber}`),
      ),
      listParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn(),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    channels = {
      getByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' } as Channel),
    };
    service = new VideosService(
      repository as unknown as VideosRepository,
      storage as unknown as StorageService,
      channels as unknown as ChannelsService,
      config,
      storageSettings as ConfigType<typeof storageConfig>,
      producer as unknown as VideoJobsProducer,
    );
  });

  describe('initiateUpload', () => {
    it('rejects a non-video content type without touching channel, db or storage', async () => {
      await expect(
        service.initiateUpload('user-1', {
          ...dto,
          content_type: 'application/pdf',
        }),
      ).rejects.toBeInstanceOf(InvalidContentTypeException);

      expect(channels.getByUserId).not.toHaveBeenCalled();
      expect(repository.createDraft).not.toHaveBeenCalled();
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('rejects a size above the configured limit without creating a draft', async () => {
      await expect(
        service.initiateUpload('user-1', {
          ...dto,
          size_bytes: config.maxBytes + 1,
        }),
      ).rejects.toBeInstanceOf(UploadSizeExceedsLimitException);

      expect(repository.createDraft).not.toHaveBeenCalled();
    });

    it('accepts a size exactly at the limit', async () => {
      const result = await service.initiateUpload('user-1', {
        ...dto,
        size_bytes: config.maxBytes,
      });

      expect(result.part_count).toBe(160);
    });

    it('propagates ChannelNotFoundException when the user has no channel', async () => {
      channels.getByUserId.mockRejectedValue(new ChannelNotFoundException());

      await expect(
        service.initiateUpload('user-1', dto),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
      expect(repository.createDraft).not.toHaveBeenCalled();
    });

    it('creates the draft, opens the multipart and returns the part plan', async () => {
      const result = await service.initiateUpload('user-1', dto);

      expect(channels.getByUserId).toHaveBeenCalledWith('user-1');
      expect(repository.createDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: 'channel-1',
          original_file_name: 'clip.mp4',
          content_type: 'video/mp4',
          size_bytes: 1024,
          part_size: 67108864,
          part_count: 1,
          upload_expires_at: expect.any(Date) as Date,
        }),
      );
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        'videos/video-uuid/original',
        'video/mp4',
      );
      expect(repository.setUploadId).toHaveBeenCalledWith('video-uuid', 'up-1');
      expect(result).toEqual({
        id: 'abcdefghijk',
        status: 'draft',
        part_size: 67108864,
        part_count: 1,
        expires_at: expect.any(String) as string,
      });
    });

    it('deletes the draft and rethrows when the storage fails to open the multipart', async () => {
      const failure = new Error('storage down');
      storage.createMultipartUpload.mockRejectedValue(failure);

      await expect(service.initiateUpload('user-1', dto)).rejects.toBe(failure);

      expect(repository.deleteDraft).toHaveBeenCalledWith('video-uuid');
      expect(repository.setUploadId).not.toHaveBeenCalled();
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('aborts the opened multipart and deletes the draft when saving the upload id fails', async () => {
      const failure = new Error('db down');
      repository.setUploadId.mockRejectedValue(failure);

      await expect(service.initiateUpload('user-1', dto)).rejects.toBe(failure);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-uuid/original',
        'up-1',
      );
      expect(repository.deleteDraft).toHaveBeenCalledWith('video-uuid');
    });

    it('still deletes the draft and rethrows the original error when the compensating abort fails', async () => {
      const failure = new Error('db down');
      repository.setUploadId.mockRejectedValue(failure);
      storage.abortMultipartUpload.mockRejectedValue(new Error('abort down'));
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(service.initiateUpload('user-1', dto)).rejects.toBe(failure);

      expect(repository.deleteDraft).toHaveBeenCalledWith('video-uuid');
    });
  });

  describe('owned draft access (part-urls / listParts)', () => {
    const draft = (overrides: Partial<Video> = {}): Video =>
      ({
        id: 'video-uuid',
        public_id: 'abcdefghijk',
        status: VideoStatus.DRAFT,
        part_size: 5242880,
        part_count: 3,
        upload_id: 'up-1',
        upload_expires_at: new Date(Date.now() + 3600_000),
        ...overrides,
      }) as Video;

    const callers: [string, () => Promise<unknown>][] = [
      ['getPartUrls', () => service.getPartUrls('user-1', 'abcdefghijk', [1])],
      [
        'listUploadedParts',
        () => service.listUploadedParts('user-1', 'abcdefghijk'),
      ],
    ];

    describe.each(callers)('%s', (_name, call) => {
      it('throws VideoNotFoundException when the video is missing or owned by another channel', async () => {
        repository.findOwnedByPublicId.mockResolvedValue(null);

        await expect(call()).rejects.toBeInstanceOf(VideoNotFoundException);
        expect(repository.findOwnedByPublicId).toHaveBeenCalledWith(
          'abcdefghijk',
          'channel-1',
        );
      });

      it('throws VideoNotInDraftException when the video left draft', async () => {
        repository.findOwnedByPublicId.mockResolvedValue(
          draft({ status: VideoStatus.PROCESSING }),
        );

        await expect(call()).rejects.toBeInstanceOf(VideoNotInDraftException);
      });

      it('throws UploadExpiredException when the draft deadline has passed', async () => {
        repository.findOwnedByPublicId.mockResolvedValue(
          draft({ upload_expires_at: new Date(Date.now() - 1000) }),
        );

        await expect(call()).rejects.toBeInstanceOf(UploadExpiredException);
      });
    });

    describe('getPartUrls', () => {
      it('signs each requested part once, ascending, with the configured expiry', async () => {
        repository.findOwnedByPublicId.mockResolvedValue(draft());

        const result = await service.getPartUrls(
          'user-1',
          'abcdefghijk',
          [2, 1, 2],
        );

        expect(result).toEqual({
          parts: [
            { part_number: 1, url: 'https://storage/part-1' },
            { part_number: 2, url: 'https://storage/part-2' },
          ],
          expires_in: 900,
        });
        expect(storage.presignUploadPart).toHaveBeenCalledTimes(2);
        expect(storage.presignUploadPart).toHaveBeenCalledWith(
          'videos/video-uuid/original',
          'up-1',
          1,
        );
      });

      it('rejects a part number above part_count without signing anything', async () => {
        repository.findOwnedByPublicId.mockResolvedValue(draft());

        await expect(
          service.getPartUrls('user-1', 'abcdefghijk', [1, 4]),
        ).rejects.toBeInstanceOf(InvalidPartNumberException);
        expect(storage.presignUploadPart).not.toHaveBeenCalled();
      });

      it('accepts a part number equal to part_count', async () => {
        repository.findOwnedByPublicId.mockResolvedValue(draft());

        const result = await service.getPartUrls('user-1', 'abcdefghijk', [3]);

        expect(result.parts).toHaveLength(1);
      });
    });

    describe('listUploadedParts', () => {
      it('maps and sorts the stored parts and echoes the part plan', async () => {
        repository.findOwnedByPublicId.mockResolvedValue(draft());
        storage.listParts.mockResolvedValue([
          { partNumber: 2, etag: '"b"', size: 10 },
          { partNumber: 1, etag: '"a"', size: 5242880 },
        ]);

        const result = await service.listUploadedParts('user-1', 'abcdefghijk');

        expect(storage.listParts).toHaveBeenCalledWith(
          'videos/video-uuid/original',
          'up-1',
        );
        expect(result).toEqual({
          part_size: 5242880,
          part_count: 3,
          parts: [
            { part_number: 1, size: 5242880, etag: '"a"' },
            { part_number: 2, size: 10, etag: '"b"' },
          ],
        });
      });
    });
  });

  describe('completeUpload / abortUpload', () => {
    const draft = (overrides: Partial<Video> = {}): Video =>
      ({
        id: 'video-uuid',
        public_id: 'abcdefghijk',
        status: VideoStatus.DRAFT,
        size_bytes: 6291456,
        part_count: 2,
        upload_id: 'up-1',
        upload_expires_at: new Date(Date.now() + 3600_000),
        ...overrides,
      }) as Video;
    const completeDto = {
      parts: [
        { part_number: 1, etag: '"a"' },
        { part_number: 2, etag: '"b"' },
      ],
    };
    const processing = {
      public_id: 'abcdefghijk',
      status: VideoStatus.PROCESSING,
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 6291456,
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      container_format: null,
      bitrate_bps: null,
      error_code: null,
      error_message: null,
      created_at: new Date('2026-11-06T12:00:00.000Z'),
      updated_at: new Date('2026-11-06T12:01:00.000Z'),
    } as Video;

    beforeEach(() => {
      repository.findOwnedByPublicId.mockResolvedValue(draft());
      storage.headObject.mockResolvedValue({ contentLength: 6291456 });
      repository.findById.mockResolvedValue(processing);
    });

    describe('completeUpload', () => {
      it('completes the multipart, moves to processing, enqueues the job and returns the video', async () => {
        const result = await service.completeUpload(
          'user-1',
          'abcdefghijk',
          completeDto,
        );

        expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
          'videos/video-uuid/original',
          'up-1',
          [
            { partNumber: 1, etag: '"a"' },
            { partNumber: 2, etag: '"b"' },
          ],
        );
        expect(repository.transitionToProcessing).toHaveBeenCalledWith(
          'video-uuid',
          expect.any(Date) as Date,
        );
        expect(producer.enqueueProcessing).toHaveBeenCalledWith('video-uuid');
        expect(result).toMatchObject({
          id: 'abcdefghijk',
          status: 'processing',
          size_bytes: 6291456,
          duration_seconds: null,
          error_code: null,
          created_at: '2026-11-06T12:00:00.000Z',
          updated_at: '2026-11-06T12:01:00.000Z',
        });
      });

      it.each([
        'InvalidPart',
        'InvalidPartOrder',
        'EntityTooSmall',
        'NoSuchUpload',
      ])(
        'maps the storage error %s to InvalidUploadPartsException without changing state',
        async (name) => {
          storage.completeMultipartUpload.mockRejectedValue(
            Object.assign(new Error(name), { name }),
          );

          await expect(
            service.completeUpload('user-1', 'abcdefghijk', completeDto),
          ).rejects.toBeInstanceOf(InvalidUploadPartsException);
          expect(repository.transitionToProcessing).not.toHaveBeenCalled();
          expect(producer.enqueueProcessing).not.toHaveBeenCalled();
        },
      );

      it('propagates unknown storage errors untouched', async () => {
        const failure = new Error('storage down');
        storage.completeMultipartUpload.mockRejectedValue(failure);

        await expect(
          service.completeUpload('user-1', 'abcdefghijk', completeDto),
        ).rejects.toBe(failure);
      });

      it('marks the draft as error and fails when the stored size differs from the declared one', async () => {
        storage.headObject.mockResolvedValue({ contentLength: 1 });

        await expect(
          service.completeUpload('user-1', 'abcdefghijk', completeDto),
        ).rejects.toBeInstanceOf(UploadSizeMismatchException);

        expect(repository.markDraftError).toHaveBeenCalledWith(
          'video-uuid',
          'UPLOAD_SIZE_MISMATCH',
          expect.any(String) as string,
        );
        expect(repository.transitionToProcessing).not.toHaveBeenCalled();
        expect(producer.enqueueProcessing).not.toHaveBeenCalled();
      });

      it('throws VideoNotInDraftException and does not enqueue when the guarded transition affects no row', async () => {
        repository.transitionToProcessing.mockResolvedValue(0);

        await expect(
          service.completeUpload('user-1', 'abcdefghijk', completeDto),
        ).rejects.toBeInstanceOf(VideoNotInDraftException);
        expect(producer.enqueueProcessing).not.toHaveBeenCalled();
      });

      it('still returns the processing video when the enqueue fails', async () => {
        producer.enqueueProcessing.mockRejectedValue(new Error('redis down'));
        const logSpy = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);

        const result = await service.completeUpload(
          'user-1',
          'abcdefghijk',
          completeDto,
        );

        expect(result.status).toBe('processing');
        expect(logSpy).toHaveBeenCalledWith(
          expect.stringContaining('video-uuid'),
          expect.any(String) as string,
        );
        logSpy.mockRestore();
      });

      it('rejects a video that is not an unexpired draft of the caller', async () => {
        repository.findOwnedByPublicId.mockResolvedValue(
          draft({ upload_expires_at: new Date(Date.now() - 1000) }),
        );

        await expect(
          service.completeUpload('user-1', 'abcdefghijk', completeDto),
        ).rejects.toBeInstanceOf(UploadExpiredException);
        expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      });
    });

    describe('abortUpload', () => {
      it('aborts the multipart and deletes the draft, even when the deadline has passed', async () => {
        repository.findOwnedByPublicId.mockResolvedValue(
          draft({ upload_expires_at: new Date(Date.now() - 1000) }),
        );

        await service.abortUpload('user-1', 'abcdefghijk');

        expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
          'videos/video-uuid/original',
          'up-1',
        );
        expect(repository.deleteDraft).toHaveBeenCalledWith('video-uuid');
      });

      it('rejects a video that already left draft without touching storage', async () => {
        repository.findOwnedByPublicId.mockResolvedValue(
          draft({ status: VideoStatus.PROCESSING }),
        );

        await expect(
          service.abortUpload('user-1', 'abcdefghijk'),
        ).rejects.toBeInstanceOf(VideoNotInDraftException);
        expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
        expect(repository.deleteDraft).not.toHaveBeenCalled();
      });

      it('throws VideoNotInDraftException when a concurrent complete removed the draft state first', async () => {
        repository.deleteDraft.mockResolvedValue(0);

        await expect(
          service.abortUpload('user-1', 'abcdefghijk'),
        ).rejects.toBeInstanceOf(VideoNotInDraftException);
      });

      it('is not found for a video of another channel', async () => {
        repository.findOwnedByPublicId.mockResolvedValue(null);

        await expect(
          service.abortUpload('user-1', 'abcdefghijk'),
        ).rejects.toBeInstanceOf(VideoNotFoundException);
      });
    });
  });

  describe('getOwnedVideo', () => {
    it('maps the entity to the response without upload_id or metadata', async () => {
      const created = new Date('2026-11-06T12:00:00.000Z');
      const updated = new Date('2026-11-06T12:05:00.000Z');
      repository.findOwnedByPublicId.mockResolvedValue({
        id: 'video-uuid',
        public_id: 'abcdefghijk',
        status: VideoStatus.READY,
        original_file_name: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        duration_seconds: 12.5,
        width: 1280,
        height: 720,
        video_codec: 'h264',
        container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitrate_bps: 800000,
        error_code: null,
        error_message: null,
        upload_id: 'up-1',
        metadata: { streams: [] },
        created_at: created,
        updated_at: updated,
      } as unknown as Video);

      const result = await service.getOwnedVideo('user-1', 'abcdefghijk');

      expect(repository.findOwnedByPublicId).toHaveBeenCalledWith(
        'abcdefghijk',
        'channel-1',
      );
      expect(result).toEqual({
        id: 'abcdefghijk',
        status: VideoStatus.READY,
        original_file_name: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        duration_seconds: 12.5,
        width: 1280,
        height: 720,
        video_codec: 'h264',
        container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitrate_bps: 800000,
        error_code: null,
        error_message: null,
        created_at: '2026-11-06T12:00:00.000Z',
        updated_at: '2026-11-06T12:05:00.000Z',
      });
      expect(result).not.toHaveProperty('upload_id');
      expect(result).not.toHaveProperty('metadata');
    });

    it('is not found for a missing video or one of another channel', async () => {
      repository.findOwnedByPublicId.mockResolvedValue(null);

      await expect(
        service.getOwnedVideo('user-1', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('does not require a draft: an error video is readable', async () => {
      repository.findOwnedByPublicId.mockResolvedValue({
        public_id: 'abcdefghijk',
        status: VideoStatus.ERROR,
        error_code: 'UNREADABLE_MEDIA',
        error_message: 'Could not read the media',
        created_at: new Date(),
        updated_at: new Date(),
      } as Video);

      const result = await service.getOwnedVideo('user-1', 'abcdefghijk');

      expect(result).toMatchObject({
        status: VideoStatus.ERROR,
        error_code: 'UNREADABLE_MEDIA',
        error_message: 'Could not read the media',
      });
    });
  });
});
