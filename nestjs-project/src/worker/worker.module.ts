import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import {
  configModuleOptions,
  typeOrmAsyncOptions,
} from '../config/infra-module-options';
import workerConfig from '../config/worker.config';
import { MediaModule } from '../media/media.module';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_SWEEP_JOB,
  VIDEO_SWEEPER_SCHEDULER_ID,
} from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { VideosModule } from '../videos/videos.module';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';
import { VideoSweeperProcessor } from './video-sweeper.processor';
import { VideoSweeperService } from './video-sweeper.service';

// Raiz do processo do worker (sem HTTP): o único módulo com @Processor. O AppModule nunca o importa (TD-05).
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeOrmAsyncOptions),
    QueueModule,
    StorageModule,
    MediaModule,
    VideosModule,
    // Sem o AppModule ninguém registra `User`, e a relação Channel#user impede o TypeORM de montar os metadados.
    TypeOrmModule.forFeature([User]),
  ],
  providers: [
    VideoProcessingService,
    VideoProcessingProcessor,
    VideoSweeperService,
    VideoSweeperProcessor,
  ],
})
export class WorkerModule implements OnModuleInit {
  constructor(
    @InjectQueue(VIDEO_MAINTENANCE_QUEUE) private readonly queue: Queue,
    @Inject(workerConfig.KEY)
    private readonly config: ConfigType<typeof workerConfig>,
  ) {}

  // upsert é idempotente: subir o worker várias vezes mantém um único scheduler (TD-09).
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      VIDEO_SWEEPER_SCHEDULER_ID,
      { every: this.config.sweeperIntervalMs },
      {
        name: VIDEO_SWEEP_JOB,
        data: {},
        opts: { attempts: 3, backoff: 3000, removeOnFail: 1000 },
      },
    );
  }
}
