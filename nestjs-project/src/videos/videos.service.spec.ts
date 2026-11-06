import { Channel } from '../channels/entities/channel.entity';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidContentTypeException,
  UploadSizeExceedsLimitException,
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

describe('VideosService', () => {
  let repository: {
    createDraft: jest.Mock;
    setUploadId: jest.Mock;
    deleteDraft: jest.Mock;
  };
  let storage: { createMultipartUpload: jest.Mock };
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
    };
    storage = { createMultipartUpload: jest.fn().mockResolvedValue('up-1') };
    channels = {
      getByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' } as Channel),
    };
    service = new VideosService(
      repository as unknown as VideosRepository,
      storage as unknown as StorageService,
      channels as unknown as ChannelsService,
      config,
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
});
