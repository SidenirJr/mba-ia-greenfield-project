import { Injectable } from '@nestjs/common';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { buildAttachmentDisposition } from './content-disposition.util';
import type { Video } from './entities/video.entity';
import { VideoStatus } from './videos.constants';
import { VideosRepository } from './videos.repository';

// Leitura pública (TD-11): qualquer vídeo `ready`, sem filtro de canal. O 206/Range é do storage, não da API (TD-08).
@Injectable()
export class VideoDeliveryService {
  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
  ) {}

  async getStreamUrl(publicId: string): Promise<string> {
    const video = await this.findReady(publicId);
    return this.storageService.presignGetObject(videoOriginalKey(video.id), {
      responseContentType: video.content_type,
    });
  }

  async getDownloadUrl(publicId: string): Promise<string> {
    const video = await this.findReady(publicId);
    return this.storageService.presignGetObject(videoOriginalKey(video.id), {
      responseContentType: video.content_type,
      responseContentDisposition: buildAttachmentDisposition(
        video.original_file_name,
      ),
    });
  }

  // Não-pronto e inexistente respondem igual (404) para não revelar o estado de vídeos ainda não liberados.
  private async findReady(publicId: string): Promise<Video> {
    const video = await this.videosRepository.findByPublicId(publicId);
    if (!video || video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }
    return video;
  }
}
