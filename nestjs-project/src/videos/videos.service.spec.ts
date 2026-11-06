import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidContentTypeException,
  InvalidPartNumberException,
  UploadExpiredException,
  UploadSizeExceedsLimitException,
  VideoNotFoundException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';
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
  };
  let storage: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    listParts: jest.Mock;
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
    };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('up-1'),
      presignUploadPart: jest.fn(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`https://storage/part-${partNumber}`),
      ),
      listParts: jest.fn().mockResolvedValue([]),
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
});
