import { Injectable, Logger } from '@nestjs/common';
import type { MediaProbeResult } from '../media/media.types';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from './videos.constants';
import { VideosRepository } from './videos.repository';

export interface VideoForProcessing {
  id: string;
  status: VideoStatus;
  content_type: string;
}

const NO_SUCH_UPLOAD = 'NoSuchUpload';

// Única porta de entrada do worker e do sweeper no `Video`: a entidade segue sob posse do VideosModule (TD-05).
@Injectable()
export class VideoPipelineService {
  private readonly logger = new Logger(VideoPipelineService.name);

  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
  ) {}

  async getForProcessing(videoId: string): Promise<VideoForProcessing | null> {
    const video = await this.videosRepository.findById(videoId);
    if (!video) return null;
    return {
      id: video.id,
      status: video.status,
      content_type: video.content_type,
    };
  }

  // Devolve se houve efeito: false significa que outro ator já fez a transição (idempotência).
  async markReady(videoId: string, probe: MediaProbeResult): Promise<boolean> {
    const affected = await this.videosRepository.markReady(videoId, {
      duration_seconds: probe.durationSeconds,
      width: probe.width,
      height: probe.height,
      video_codec: probe.videoCodec,
      container_format: probe.containerFormat,
      bitrate_bps: probe.bitrateBps,
      metadata: probe.metadata,
    });
    return affected > 0;
  }

  async markError(
    videoId: string,
    code: string,
    message: string,
  ): Promise<boolean> {
    return (await this.videosRepository.markError(videoId, code, message)) > 0;
  }

  // Contexto de background: uma falha em um rascunho é registrada e não impede a limpeza dos demais.
  async abortExpiredDrafts(now: Date, limit: number): Promise<number> {
    const drafts = await this.videosRepository.findExpiredDrafts(now, limit);
    let cleaned = 0;
    for (const draft of drafts) {
      try {
        if (draft.upload_id) {
          await this.abortMultipart(draft.id, draft.upload_id);
        }
        cleaned += await this.videosRepository.deleteDraft(draft.id);
      } catch (err) {
        this.logger.warn(
          `Could not clean expired draft ${draft.id}: ${(err as Error).message}`,
        );
      }
    }
    return cleaned;
  }

  async findStaleProcessingIds(
    olderThan: Date,
    limit: number,
  ): Promise<string[]> {
    const stale = await this.videosRepository.findStaleProcessing(
      olderThan,
      limit,
    );
    return stale.map((video) => video.id);
  }

  private async abortMultipart(
    videoId: string,
    uploadId: string,
  ): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(
        videoOriginalKey(videoId),
        uploadId,
      );
    } catch (err) {
      // Multipart já inexistente: o objetivo da limpeza (nenhum multipart aberto) está cumprido.
      if ((err as { name?: string }).name !== NO_SUCH_UPLOAD) throw err;
    }
  }
}
