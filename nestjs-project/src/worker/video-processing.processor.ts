import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import {
  MediaProcessingError,
  sanitizeSignedUrls,
} from '../media/media-processing.error';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { VideoPipelineService } from '../videos/video-pipeline.service';
import { VideoProcessingService } from './video-processing.service';

export const PROCESSING_FAILED_CODE = 'PROCESSING_FAILED';

export interface VideoProcessingJobData {
  videoId: string;
}

// Único @Processor de vídeo e só existe no WorkerModule: provê-lo em outro módulo faria a API também consumir jobs (TD-05).
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly videoProcessingService: VideoProcessingService,
    private readonly videoPipelineService: VideoPipelineService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    try {
      await this.videoProcessingService.process(job.data.videoId);
    } catch (err) {
      // Mídia ilegível não melhora com retry: UnrecoverableError pula as tentativas restantes.
      if (err instanceof MediaProcessingError && !err.retryable) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }

  // Falha final (sem tentativas restantes): o vídeo deixa de ficar preso em `processing`.
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJobData> | undefined,
    err: Error,
  ): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (!(err instanceof UnrecoverableError) && job.attemptsMade < attempts) {
      return;
    }
    const { videoId } = job.data;
    try {
      // Guardado: se o serviço já registrou um erro de conteúdo (ou o vídeo já está ready), não tem efeito.
      await this.videoPipelineService.markError(
        videoId,
        PROCESSING_FAILED_CODE,
        sanitizeSignedUrls(err.message),
      );
    } catch (markErr) {
      // Contexto de background: relançar derrubaria o listener; o sweeper reenfileira o `processing` esquecido.
      this.logger.error(
        `Could not record the final failure of video ${videoId}: ${(markErr as Error).message}`,
      );
    }
  }
}
