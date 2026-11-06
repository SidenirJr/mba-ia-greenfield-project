import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  processVideoJobId,
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';

const LIVE_STATES = ['waiting', 'active', 'delayed', 'prioritized'];

@Injectable()
export class VideoJobsProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(
      VIDEO_PROCESS_JOB,
      { videoId },
      { jobId: processVideoJobId(videoId) },
    );
  }

  // O jobId fixo faz o `add` ser ignorado enquanto o registro failed/completed existir: remove-o antes de re-adicionar.
  async ensureProcessingJob(videoId: string): Promise<void> {
    const job = await this.queue.getJob(processVideoJobId(videoId));
    if (job) {
      if (LIVE_STATES.includes(await job.getState())) return;
      await job.remove();
    }
    await this.enqueueProcessing(videoId);
  }
}
