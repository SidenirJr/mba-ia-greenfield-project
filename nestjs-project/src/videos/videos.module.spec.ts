import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { QueueModule } from '../queue/queue.module';
import { VideoJobsProducer } from '../queue/video-jobs.producer';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';

const repositoryMock = {};

// DataSource falso e global: `forFeature` só precisa dele para resolver o repositório (sem conexão).
@Module({
  providers: [
    {
      provide: DataSource,
      useValue: {
        entityMetadatas: [],
        options: { type: 'postgres' },
        getRepository: () => repositoryMock,
      },
    },
  ],
  exports: [DataSource],
})
class FakeDataSourceModule {}

// Substitui o QueueModule real (que abriria conexão com o Redis): este spec só valida a fiação de DI.
@Module({
  providers: [{ provide: VideoJobsProducer, useValue: {} }],
  exports: [VideoJobsProducer],
})
class FakeQueueModule {}

describe('VideosModule', () => {
  it('should compile and expose the Video repository', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, uploadConfig],
        }),
        { module: FakeDataSourceModule, global: true },
        VideosModule,
      ],
    })
      .overrideModule(QueueModule)
      .useModule(FakeQueueModule)
      .compile();

    expect(moduleRef.get(getRepositoryToken(Video))).toBe(repositoryMock);
    await moduleRef.close();
  });
});
