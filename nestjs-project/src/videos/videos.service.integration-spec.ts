import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidContentTypeException,
  UploadSizeExceedsLimitException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { createTestBucket, type TestBucket } from '../test/storage-test';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let testBucket: TestBucket;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let user: User;
  let channel: Channel;
  let counter = 0;

  beforeAll(async () => {
    testBucket = await createTestBucket();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, uploadConfig],
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
    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await testBucket.cleanup();
    await moduleRef.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    user = await dataSource.getRepository(User).save({
      email: `videos_svc_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Chan',
      nickname: `svcchan${counter}`,
      user_id: user.id,
    });
  });

  const dto = {
    file_name: 'clip.mp4',
    size_bytes: 10737418240,
    content_type: 'video/mp4',
  };
  const videoCount = () => dataSource.getRepository(Video).count();

  describe('initiateUpload', () => {
    it('creates a draft of the caller channel with upload id and expiry, and opens a real multipart', async () => {
      const before = Date.now();

      const result = await service.initiateUpload(user.id, dto);

      expect(result).toMatchObject({
        status: 'draft',
        part_size: 67108864,
        part_count: 160,
      });
      expect(result.id).toHaveLength(11);
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: result.id });
      expect(video.channel_id).toBe(channel.id);
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.upload_id).toEqual(expect.any(String));
      const expectedExpiry = before + 24 * 3600_000;
      expect(
        Math.abs(video.upload_expires_at!.getTime() - expectedExpiry),
      ).toBeLessThan(60_000);
      expect(result.expires_at).toBe(video.upload_expires_at!.toISOString());
      // ListParts só responde para um multipart realmente aberto no storage.
      await expect(
        storage.listParts(videoOriginalKey(video.id), video.upload_id!),
      ).resolves.toEqual([]);
    });

    it('rejects a size above the limit without creating a row', async () => {
      await expect(
        service.initiateUpload(user.id, { ...dto, size_bytes: 10737418241 }),
      ).rejects.toBeInstanceOf(UploadSizeExceedsLimitException);

      expect(await videoCount()).toBe(0);
    });

    it('rejects a non-video content type without creating a row', async () => {
      await expect(
        service.initiateUpload(user.id, {
          ...dto,
          content_type: 'application/pdf',
        }),
      ).rejects.toBeInstanceOf(InvalidContentTypeException);

      expect(await videoCount()).toBe(0);
    });

    it('fails with ChannelNotFoundException for a user without channel', async () => {
      await dataSource.query('DELETE FROM "channels"');

      await expect(service.initiateUpload(user.id, dto)).rejects.toBeInstanceOf(
        ChannelNotFoundException,
      );
      expect(await videoCount()).toBe(0);
    });

    it('leaves no draft row when CreateMultipartUpload fails', async () => {
      const failure = new Error('storage down');
      jest.spyOn(storage, 'createMultipartUpload').mockRejectedValue(failure);

      await expect(service.initiateUpload(user.id, dto)).rejects.toBe(failure);

      expect(await videoCount()).toBe(0);
    });
  });
});
