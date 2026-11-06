import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import workerConfig from '../config/worker.config';
import { VideoJobsProducer } from '../queue/video-jobs.producer';
import { VideoPipelineService } from '../videos/video-pipeline.service';

// shortcut: lote fixo por varredura; o que sobrar é tratado na próxima execução. Tornar configurável se o backlog crescer.
export const SWEEP_BATCH_LIMIT = 100;

export interface SweepResult {
  abortedDrafts: number;
  requeuedVideos: number;
}

// Ações idempotentes (TD-04/TD-09): rodar duas vezes seguidas não tem efeito extra.
@Injectable()
export class VideoSweeperService {
  private readonly logger = new Logger(VideoSweeperService.name);

  constructor(
    private readonly videoPipelineService: VideoPipelineService,
    private readonly videoJobsProducer: VideoJobsProducer,
    @Inject(workerConfig.KEY)
    private readonly config: ConfigType<typeof workerConfig>,
  ) {}

  // As duas etapas são independentes: uma falha não impede a outra, e o erro é relançado no fim para o retry do job.
  async sweep(now: Date): Promise<SweepResult> {
    const errors: unknown[] = [];
    const result: SweepResult = { abortedDrafts: 0, requeuedVideos: 0 };

    try {
      result.abortedDrafts = await this.videoPipelineService.abortExpiredDrafts(
        now,
        SWEEP_BATCH_LIMIT,
      );
    } catch (err) {
      this.logger.error(
        `Expired drafts cleanup failed: ${(err as Error).message}`,
      );
      errors.push(err);
    }

    try {
      result.requeuedVideos = await this.requeueStaleProcessing(now);
    } catch (err) {
      this.logger.error(
        `Stale processing reconciliation failed: ${(err as Error).message}`,
      );
      errors.push(err);
    }

    if (errors.length > 0) throw errors[0];
    return result;
  }

  private async requeueStaleProcessing(now: Date): Promise<number> {
    const olderThan = new Date(now.getTime() - this.config.processingStaleMs);
    const ids = await this.videoPipelineService.findStaleProcessingIds(
      olderThan,
      SWEEP_BATCH_LIMIT,
    );
    for (const id of ids) {
      await this.videoJobsProducer.ensureProcessingJob(id);
    }
    return ids.length;
  }
}
