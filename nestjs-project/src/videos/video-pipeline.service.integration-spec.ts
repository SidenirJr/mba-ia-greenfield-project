import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import type { MediaProbeResult } from '../media/media.types';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { createTestBucket, type TestBucket } from '../test/storage-test';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoPipelineService } from './video-pipeline.service';
import { VideoStatus } from './videos.constants';
import { VideosModule } from './videos.module';
import { CreateDraftData, VideosRepository } from './videos.repository';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const probe: MediaProbeResult = {
  durationSeconds: 12.5,
  width: 640,
  height: 360,
  videoCodec: 'h264',
  containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
  bitrateBps: 800000,
  metadata: { format: { format_name: 'mp4' }, streams: [] },
};

describe('VideoPipelineService (integration)', () => {
  let testBucket: TestBucket;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: VideoPipelineService;
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
    service = moduleRef.get(VideoPipelineService);
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
      email: `pipeline_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Chan',
      nickname: `pipechan${counter}`,
      user_id: user.id,
    });
  });

  const draftData = (
    overrides: Partial<CreateDraftData> = {},
  ): CreateDraftData => ({
    channel_id: channel.id,
    original_file_name: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 1024,
    part_size: 67108864,
    part_count: 1,
    upload_expires_at: new Date(Date.now() + 3600_000),
    ...overrides,
  });

  const processingVideo = async () => {
    const video = await repository.createDraft(draftData());
    await repository.transitionToProcessing(video.id, new Date());
    return video;
  };

  // Rascunho com multipart realmente aberto no bucket de teste.
  const draftWithMultipart = async (expiresAt: Date) => {
    const video = await repository.createDraft(
      draftData({ upload_expires_at: expiresAt }),
    );
    const uploadId = await storage.createMultipartUpload(
      videoOriginalKey(video.id),
      'video/mp4',
    );
    await repository.setUploadId(video.id, uploadId);
    return { video, uploadId };
  };

  const openUploadIds = async (): Promise<string[]> =>
    (
      await testBucket.client.send(
        new ListMultipartUploadsCommand({ Bucket: testBucket.bucket }),
      )
    ).Uploads?.map((u) => u.UploadId as string) ?? [];

  const reload = (id: string) =>
    dataSource.getRepository(Video).findOneByOrFail({ id });

  describe('getForProcessing', () => {
    it('returns the status of an existing video and null for an unknown id', async () => {
      const video = await processingVideo();

      await expect(service.getForProcessing(video.id)).resolves.toEqual({
        id: video.id,
        status: VideoStatus.PROCESSING,
        content_type: 'video/mp4',
      });
      await expect(
        service.getForProcessing('00000000-0000-4000-8000-000000000000'),
      ).resolves.toBeNull();
    });
  });

  describe('markReady', () => {
    it('stores the normalized metadata on a processing video and sets it ready', async () => {
      const video = await processingVideo();

      await expect(service.markReady(video.id, probe)).resolves.toBe(true);

      const saved = await reload(video.id);
      expect(saved).toMatchObject({
        status: VideoStatus.READY,
        duration_seconds: 12.5,
        width: 640,
        height: 360,
        video_codec: 'h264',
        container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
        bitrate_bps: 800000,
        metadata: probe.metadata,
        error_code: null,
        error_message: null,
      });
    });

    it('changes nothing on a video that is already ready', async () => {
      const video = await processingVideo();
      await service.markReady(video.id, probe);

      await expect(
        service.markReady(video.id, { ...probe, durationSeconds: 99 }),
      ).resolves.toBe(false);

      expect((await reload(video.id)).duration_seconds).toBe(12.5);
    });

    it('does not touch a draft', async () => {
      const draft = await repository.createDraft(draftData());

      await expect(service.markReady(draft.id, probe)).resolves.toBe(false);

      expect((await reload(draft.id)).status).toBe(VideoStatus.DRAFT);
    });
  });

  describe('markError', () => {
    it('records the error on a processing video', async () => {
      const video = await processingVideo();

      await expect(
        service.markError(video.id, 'UNREADABLE_MEDIA', 'broken'),
      ).resolves.toBe(true);

      expect(await reload(video.id)).toMatchObject({
        status: VideoStatus.ERROR,
        error_code: 'UNREADABLE_MEDIA',
        error_message: 'broken',
      });
    });

    it('changes nothing on a ready video', async () => {
      const video = await processingVideo();
      await service.markReady(video.id, probe);

      await expect(service.markError(video.id, 'X', 'late')).resolves.toBe(
        false,
      );

      expect(await reload(video.id)).toMatchObject({
        status: VideoStatus.READY,
        error_code: null,
      });
    });
  });

  describe('abortExpiredDrafts', () => {
    it('aborts the real multipart and removes the row of each expired draft, leaving valid drafts alone', async () => {
      const expired = await draftWithMultipart(new Date(Date.now() - 1000));
      const expiredToo = await draftWithMultipart(new Date(Date.now() - 5000));
      const valid = await draftWithMultipart(new Date(Date.now() + 3600_000));
      expect(await openUploadIds()).toEqual(
        expect.arrayContaining([
          expired.uploadId,
          expiredToo.uploadId,
          valid.uploadId,
        ]),
      );

      const cleaned = await service.abortExpiredDrafts(new Date(), 10);

      expect(cleaned).toBe(2);
      const open = await openUploadIds();
      expect(open).not.toContain(expired.uploadId);
      expect(open).not.toContain(expiredToo.uploadId);
      expect(open).toContain(valid.uploadId);
      expect(await repository.findById(expired.video.id)).toBeNull();
      expect(await repository.findById(expiredToo.video.id)).toBeNull();
      expect(await repository.findById(valid.video.id)).not.toBeNull();
    });

    it('still deletes the row when the multipart was already aborted', async () => {
      const { video, uploadId } = await draftWithMultipart(
        new Date(Date.now() - 1000),
      );
      await storage.abortMultipartUpload(videoOriginalKey(video.id), uploadId);

      await expect(service.abortExpiredDrafts(new Date(), 10)).resolves.toBe(1);

      expect(await repository.findById(video.id)).toBeNull();
    });

    it('respects the limit and does not touch non-draft videos', async () => {
      await draftWithMultipart(new Date(Date.now() - 1000));
      await draftWithMultipart(new Date(Date.now() - 2000));
      const processing = await processingVideo();

      await expect(service.abortExpiredDrafts(new Date(), 1)).resolves.toBe(1);

      expect(await dataSource.getRepository(Video).count()).toBe(2);
      expect(await repository.findById(processing.id)).not.toBeNull();
    });
  });

  describe('findStaleProcessingIds', () => {
    it('returns only processing videos started before the threshold', async () => {
      const stale = await processingVideo();
      await dataSource
        .getRepository(Video)
        .update(
          { id: stale.id },
          { processing_started_at: new Date(Date.now() - 2 * 3600_000) },
        );
      await processingVideo();

      const ids = await service.findStaleProcessingIds(
        new Date(Date.now() - 3600_000),
        10,
      );

      expect(ids).toEqual([stale.id]);
    });
  });
});
