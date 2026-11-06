import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoPipelineService } from './video-pipeline.service';
import { VideosController } from './videos.controller';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    ChannelsModule,
    QueueModule,
  ],
  controllers: [VideosController],
  providers: [VideosRepository, VideosService, VideoPipelineService],
  exports: [
    TypeOrmModule,
    VideosRepository,
    VideosService,
    VideoPipelineService,
  ],
})
export class VideosModule {}
