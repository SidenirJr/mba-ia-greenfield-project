import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import type { StorageService } from '../storage/storage.service';
import type { Video } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoStatus } from './videos.constants';
import type { VideosRepository } from './videos.repository';

const readyVideo = {
  id: 'uuid-1',
  public_id: 'abcdefghijk',
  status: VideoStatus.READY,
  content_type: 'video/webm',
  original_file_name: 'my "clip".webm',
} as Video;

describe('VideoDeliveryService', () => {
  let repository: { findByPublicId: jest.Mock };
  let storage: { presignGetObject: jest.Mock };
  let service: VideoDeliveryService;

  beforeEach(() => {
    repository = { findByPublicId: jest.fn().mockResolvedValue(readyVideo) };
    storage = {
      presignGetObject: jest.fn().mockResolvedValue('http://signed/url'),
    };
    service = new VideoDeliveryService(
      repository as unknown as VideosRepository,
      storage as unknown as StorageService,
    );
  });

  it('presigns the original with the stored content type for streaming', async () => {
    await expect(service.getStreamUrl('abcdefghijk')).resolves.toBe(
      'http://signed/url',
    );

    expect(repository.findByPublicId).toHaveBeenCalledWith('abcdefghijk');
    expect(storage.presignGetObject).toHaveBeenCalledWith(
      'videos/uuid-1/original',
      { responseContentType: 'video/webm' },
    );
  });

  it('adds a sanitized attachment disposition for download', async () => {
    await service.getDownloadUrl('abcdefghijk');

    expect(storage.presignGetObject).toHaveBeenCalledWith(
      'videos/uuid-1/original',
      {
        responseContentType: 'video/webm',
        responseContentDisposition: `attachment; filename="my clip.webm"; filename*=UTF-8''my%20clip.webm`,
      },
    );
  });

  it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
    'answers VideoNotFoundException for a %s video, without presigning',
    async (status) => {
      repository.findByPublicId.mockResolvedValue({ ...readyVideo, status });

      await expect(service.getStreamUrl('abcdefghijk')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
      await expect(
        service.getDownloadUrl('abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storage.presignGetObject).not.toHaveBeenCalled();
    },
  );

  it('answers VideoNotFoundException for an unknown id', async () => {
    repository.findByPublicId.mockResolvedValue(null);

    await expect(service.getStreamUrl('zzzzzzzzzzz')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
    await expect(service.getDownloadUrl('zzzzzzzzzzz')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
  });
});
