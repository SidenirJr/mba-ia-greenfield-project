import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import redisConfig from '../config/redis.config';
import {
  PROCESSING_ATTEMPTS,
  PROCESSING_BACKOFF_DELAY_MS,
  PROCESSING_BACKOFF_JITTER,
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from './queue.constants';
import { VideoJobsProducer } from './video-jobs.producer';

// Só o lado produtor: nenhum @Processor aqui; os consumidores vivem no WorkerModule (TD-05).
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>) => ({
        connection: { host: config.host, port: config.port },
        prefix: config.queuePrefix,
      }),
    }),
    BullModule.registerQueue(
      {
        name: VIDEO_PROCESSING_QUEUE,
        defaultJobOptions: {
          attempts: PROCESSING_ATTEMPTS,
          backoff: {
            type: 'exponential',
            delay: PROCESSING_BACKOFF_DELAY_MS,
            jitter: PROCESSING_BACKOFF_JITTER,
          },
        },
      },
      { name: VIDEO_MAINTENANCE_QUEUE },
    ),
  ],
  providers: [VideoJobsProducer],
  exports: [BullModule, VideoJobsProducer],
})
export class QueueModule {}
