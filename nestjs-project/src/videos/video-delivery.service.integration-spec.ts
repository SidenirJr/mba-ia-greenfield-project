import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createTestBucket,
  requestPresignedUrl,
  type TestBucket,
} from '../test/storage-test';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoDeliveryService } from './video-delivery.service';
import { VideoStatus } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosRepository } from './videos.repository';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const OBJECT_SIZE = 1000;

describe('VideoDeliveryService (integration)', () => {
  let testBucket: TestBucket;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: VideoDeliveryService;
  let repository: VideosRepository;
  let storage: StorageService;
  let channel: Channel;
  let counter = 0;

  beforeAll(async () => {
    testBucket = await createTestBucket();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, uploadConfig, redisConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useFactory({
        factory: () => ({ ...storageConfig(), bucket: testBucket.bucket }),
      })
      .compile();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideoDeliveryService);
    repository = moduleRef.get(VideosRepository);
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await testBucket.cleanup();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `delivery_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Chan',
      nickname: `delchan${counter}`,
      user_id: user.id,
    });
  });

  // O objeto é salvo como octet-stream: o Content-Type da resposta só vira o do vídeo pelo override do presign.
  async function seedVideo(
    status: VideoStatus,
    fileName = 'clip.mp4',
  ): Promise<Video> {
    const video = await repository.createDraft({
      channel_id: channel.id,
      original_file_name: fileName,
      content_type: 'video/mp4',
      size_bytes: OBJECT_SIZE,
      part_size: 67108864,
      part_count: 1,
      upload_expires_at: new Date(Date.now() + 3600_000),
    });
    await storage.putObject(
      videoOriginalKey(video.id),
      Buffer.alloc(OBJECT_SIZE, 7),
      'application/octet-stream',
    );
    if (status !== VideoStatus.DRAFT) {
      await repository.transitionToProcessing(video.id, new Date());
    }
    if (status === VideoStatus.READY) {
      await repository.markReady(video.id, {
        duration_seconds: 1,
        width: 640,
        height: 360,
        video_codec: 'h264',
        container_format: 'mp4',
        bitrate_bps: 1000,
        metadata: { format: {}, streams: [] },
      });
    }
    if (status === VideoStatus.ERROR) {
      await repository.markError(video.id, 'UNREADABLE_MEDIA', 'bad');
    }
    return (await repository.findById(video.id)) as Video;
  }

  it('streams: the presigned URL uses the public host and answers 200 with the stored content type', async () => {
    const video = await seedVideo(VideoStatus.READY);

    const url = await service.getStreamUrl(video.public_id);

    expect(new URL(url).host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT as string).host,
    );
    expect(new URL(url).pathname).toContain(videoOriginalKey(video.id));
    const res = await requestPresignedUrl(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.body).toHaveLength(OBJECT_SIZE);
  });

  it('streams: a Range request to the presigned URL is answered by the storage with 206 and Content-Range', async () => {
    const video = await seedVideo(VideoStatus.READY);

    const res = await requestPresignedUrl(
      await service.getStreamUrl(video.public_id),
      { range: 'bytes=0-99' },
    );

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-99/${OBJECT_SIZE}`);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.body).toHaveLength(100);
  });

  it('downloads: the presigned URL makes the storage answer Content-Disposition attachment with the original name', async () => {
    const video = await seedVideo(VideoStatus.READY, 'my holiday.mp4');

    const url = await service.getDownloadUrl(video.public_id);

    expect(new URL(url).searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="my holiday.mp4"; filename*=UTF-8''my%20holiday.mp4`,
    );
    const res = await requestPresignedUrl(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="my holiday.mp4"; filename*=UTF-8''my%20holiday.mp4`,
    );
  });

  it('downloads: a name with quotes and line breaks never reaches the header', async () => {
    const video = await seedVideo(VideoStatus.READY, 'a"b\r\nX-Evil: 1.mp4');

    const res = await requestPresignedUrl(
      await service.getDownloadUrl(video.public_id),
    );

    expect(res.status).toBe(200);
    const header = res.headers['content-disposition'] as string;
    expect(header).toBe(
      `attachment; filename="abX-Evil: 1.mp4"; filename*=UTF-8''abX-Evil%3A%201.mp4`,
    );
    expect(res.headers['x-evil']).toBeUndefined();
  });

  it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
    'answers VideoNotFoundException for both URLs when the video is %s',
    async (status) => {
      const video = await seedVideo(status);

      await expect(
        service.getStreamUrl(video.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.getDownloadUrl(video.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    },
  );

  it('answers VideoNotFoundException for an unknown public id', async () => {
    await expect(service.getStreamUrl('zzzzzzzzzzz')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
  });
});
