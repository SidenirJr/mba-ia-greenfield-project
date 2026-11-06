import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  configModuleOptions,
  typeOrmAsyncOptions,
} from '../config/infra-module-options';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos/videos.module';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

// Raiz do processo do worker (sem HTTP): o único módulo com @Processor. O AppModule nunca o importa (TD-05).
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeOrmAsyncOptions),
    QueueModule,
    StorageModule,
    MediaModule,
    VideosModule,
  ],
  providers: [VideoProcessingService, VideoProcessingProcessor],
})
export class WorkerModule {}
