import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { VIDEO_MAINTENANCE_QUEUE } from '../queue/queue.constants';
import { VideoSweeperService } from './video-sweeper.service';

// Só existe no WorkerModule (TD-05): a API nunca consome a fila de manutenção.
@Processor(VIDEO_MAINTENANCE_QUEUE)
export class VideoSweeperProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoSweeperProcessor.name);

  constructor(private readonly videoSweeperService: VideoSweeperService) {
    super();
  }

  async process(): Promise<void> {
    try {
      const result = await this.videoSweeperService.sweep(new Date());
      this.logger.log(
        `Sweep done: ${result.abortedDrafts} expired draft(s) removed, ${result.requeuedVideos} stale video(s) re-enqueued`,
      );
    } catch (err) {
      // Relançar mantém o retry do BullMQ (attempts do template do scheduler).
      this.logger.error(`Sweep failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
