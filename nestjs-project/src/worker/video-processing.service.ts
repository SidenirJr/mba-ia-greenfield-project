import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import workerConfig from '../config/worker.config';
import { MediaProcessingError } from '../media/media-processing.error';
import { MediaToolsService } from '../media/media-tools.service';
import {
  videoOriginalKey,
  videoThumbnailKey,
} from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { VideoPipelineService } from '../videos/video-pipeline.service';
import { VideoStatus } from '../videos/videos.constants';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';
const MS_PER_SECOND = 1000;
// A URL interna serve ao ffprobe e ao ffmpeg, cada um com até FFMPEG_TIMEOUT_MS; a folga cobre o upload da thumbnail.
const URL_TTL_MARGIN_SECONDS = 60;

@Injectable()
export class VideoProcessingService {
  constructor(
    private readonly videoPipelineService: VideoPipelineService,
    private readonly storageService: StorageService,
    private readonly mediaToolsService: MediaToolsService,
    @Inject(workerConfig.KEY)
    private readonly config: ConfigType<typeof workerConfig>,
  ) {}

  // Idempotente (at-least-once): só trabalha em vídeo `processing`; o resto é ack sem efeito (TD-04).
  async process(videoId: string): Promise<void> {
    const video = await this.videoPipelineService.getForProcessing(videoId);
    if (video?.status !== VideoStatus.PROCESSING) return;

    const inputUrl = await this.storageService.presignInternalGetObject(
      videoOriginalKey(videoId),
      Math.ceil(this.config.ffmpegTimeoutMs / MS_PER_SECOND) * 2 +
        URL_TTL_MARGIN_SECONDS,
    );

    try {
      const probe = await this.mediaToolsService.probe(inputUrl);
      const thumbnail = await this.mediaToolsService.extractThumbnail(
        inputUrl,
        probe.durationSeconds,
      );
      // Chave determinística: uma reentrega sobrescreve a mesma thumbnail.
      await this.storageService.putObject(
        videoThumbnailKey(videoId),
        thumbnail,
        THUMBNAIL_CONTENT_TYPE,
      );
      await this.videoPipelineService.markReady(videoId, probe);
    } catch (err) {
      // Só erro de conteúdo (não-retryable) vira `error`; falha transitória segue para o retry do BullMQ.
      if (err instanceof MediaProcessingError && !err.retryable) {
        await this.videoPipelineService.markError(
          videoId,
          err.code,
          err.message,
        );
      }
      throw err;
    }
  }
}
