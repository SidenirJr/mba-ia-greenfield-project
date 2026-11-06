import { ListMultipartUploadsCommand } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidContentTypeException,
  InvalidPartNumberException,
  InvalidUploadPartsException,
  UploadExpiredException,
  UploadSizeExceedsLimitException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import {
  processVideoJobId,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { VideoJobsProducer } from '../queue/video-jobs.producer';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { obliterateQueues, uniqueQueuePrefix } from '../test/queue-test';
import {
  createTestBucket,
  requestPresignedUrl,
  type TestBucket,
} from '../test/storage-test';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoStatus } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MIN_PART = 5 * 1024 * 1024;
const queuePrefix = uniqueQueuePrefix();

// Objeto mutável compartilhado com o serviço: permite um part size de 5 MiB só nos testes que enviam partes reais.
const uploadSettings = { ...uploadConfig() };

describe('VideosService (integration)', () => {
  let testBucket: TestBucket;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let processingQueue: Queue;
  let user: User;
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
      .overrideProvider(uploadConfig.KEY)
      .useValue(uploadSettings)
      .overrideProvider(redisConfig.KEY)
      .useFactory({
        factory: () => ({ ...redisConfig(), queuePrefix: queuePrefix }),
      })
      .compile();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideosService);
    storage = moduleRef.get(StorageService);
    processingQueue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await obliterateQueues(processingQueue);
    await testBucket.cleanup();
    await moduleRef.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    uploadSettings.partSizeBytes = uploadConfig().partSizeBytes;
    await obliterateQueues(processingQueue);
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

    it('aborts the real multipart and leaves no row when saving the upload id fails', async () => {
      const failure = new Error('db down');
      jest
        .spyOn(moduleRef.get(VideosRepository), 'setUploadId')
        .mockRejectedValue(failure);
      // Outros testes deixam multiparts abertos no bucket: compara a contagem antes e depois.
      const openUploads = async () =>
        (
          await testBucket.client.send(
            new ListMultipartUploadsCommand({ Bucket: testBucket.bucket }),
          )
        ).Uploads?.length ?? 0;
      const before = await openUploads();

      await expect(service.initiateUpload(user.id, dto)).rejects.toBe(failure);

      expect(await videoCount()).toBe(0);
      expect(await openUploads()).toBe(before);
    });

    it('leaves no draft row when CreateMultipartUpload fails', async () => {
      const failure = new Error('storage down');
      jest.spyOn(storage, 'createMultipartUpload').mockRejectedValue(failure);

      await expect(service.initiateUpload(user.id, dto)).rejects.toBe(failure);

      expect(await videoCount()).toBe(0);
    });
  });

  describe('part URLs and uploaded parts', () => {
    // 6 MiB com partes de 5 MiB → 2 partes (5 MiB + 1 MiB).
    const SIZE = MIN_PART + 1024 * 1024;

    async function startUpload() {
      uploadSettings.partSizeBytes = MIN_PART;
      const started = await service.initiateUpload(user.id, {
        file_name: 'clip.mp4',
        size_bytes: SIZE,
        content_type: 'video/mp4',
      });
      return { publicId: started.id, started };
    }

    async function putPart(url: string, size: number) {
      return requestPresignedUrl(url, {
        method: 'PUT',
        body: Buffer.alloc(size, 1),
        publicHost: new URL(url).host,
      });
    }

    it('signs URLs for the public host that really accept the part, then lists it', async () => {
      const { publicId, started } = await startUpload();
      expect(started).toMatchObject({ part_size: MIN_PART, part_count: 2 });

      const { parts, expires_in } = await service.getPartUrls(
        user.id,
        publicId,
        [1, 2],
      );

      expect(expires_in).toBe(storageConfig().presignExpiresSeconds);
      expect(parts.map((p) => p.part_number)).toEqual([1, 2]);
      const publicHost = new URL(storageConfig().publicEndpoint).host;
      for (const part of parts) {
        expect(new URL(part.url).host).toBe(publicHost);
      }

      const put = await putPart(parts[0].url, MIN_PART);
      expect(put.status).toBe(200);

      const listed = await service.listUploadedParts(user.id, publicId);
      expect(listed).toMatchObject({
        part_size: MIN_PART,
        part_count: 2,
        parts: [
          { part_number: 1, size: MIN_PART, etag: put.headers.etag as string },
        ],
      });
    });

    it('re-issues a URL for an already uploaded part and the part can be overwritten', async () => {
      const { publicId } = await startUpload();
      const first = await service.getPartUrls(user.id, publicId, [1]);
      await putPart(first.parts[0].url, MIN_PART);

      const second = await service.getPartUrls(user.id, publicId, [1]);
      const put = await putPart(second.parts[0].url, MIN_PART);

      expect(put.status).toBe(200);
      const listed = await service.listUploadedParts(user.id, publicId);
      expect(listed.parts).toHaveLength(1);
    });

    it('rejects a part number above part_count', async () => {
      const { publicId } = await startUpload();

      await expect(
        service.getPartUrls(user.id, publicId, [3]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
    });

    it('answers VideoNotFoundException for a video of another channel', async () => {
      const { publicId } = await startUpload();
      const other = await dataSource.getRepository(User).save({
        email: `videos_svc_other_${counter}@example.com`,
        password: 'hashed',
      });
      await dataSource.getRepository(Channel).save({
        name: 'Other',
        nickname: `othersvcchan${counter}`,
        user_id: other.id,
      });

      await expect(
        service.getPartUrls(other.id, publicId, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.listUploadedParts(other.id, publicId),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('rejects a video that left draft and an expired draft', async () => {
      const { publicId } = await startUpload();
      const videos = dataSource.getRepository(Video);

      await videos.update(
        { public_id: publicId },
        { upload_expires_at: new Date(Date.now() - 1000) },
      );
      await expect(
        service.getPartUrls(user.id, publicId, [1]),
      ).rejects.toBeInstanceOf(UploadExpiredException);

      await videos.update(
        { public_id: publicId },
        { status: VideoStatus.PROCESSING },
      );
      await expect(
        service.listUploadedParts(user.id, publicId),
      ).rejects.toBeInstanceOf(VideoNotInDraftException);
    });
  });

  describe('completeUpload / abortUpload', () => {
    const SIZE = MIN_PART + 1024 * 1024;

    async function startUpload(sizeBytes = SIZE) {
      uploadSettings.partSizeBytes = MIN_PART;
      const started = await service.initiateUpload(user.id, {
        file_name: 'clip.mp4',
        size_bytes: sizeBytes,
        content_type: 'video/mp4',
      });
      return started.id;
    }

    // Envia as partes reais pelo caminho de produção (URL pré-assinada) e devolve as ETags.
    async function uploadParts(publicId: string, sizes: number[]) {
      const { parts } = await service.getPartUrls(
        user.id,
        publicId,
        sizes.map((_, i) => i + 1),
      );
      const completed: { part_number: number; etag: string }[] = [];
      for (const [i, part] of parts.entries()) {
        const put = await requestPresignedUrl(part.url, {
          method: 'PUT',
          body: Buffer.alloc(sizes[i], i + 1),
          publicHost: new URL(part.url).host,
        });
        expect(put.status).toBe(200);
        completed.push({
          part_number: part.part_number,
          etag: put.headers.etag as string,
        });
      }
      return completed;
    }

    const loadVideo = (publicId: string) =>
      dataSource.getRepository(Video).findOneByOrFail({ public_id: publicId });

    it('completes a real 2-part upload, moves to processing and leaves exactly one job', async () => {
      const publicId = await startUpload();
      const parts = await uploadParts(publicId, [MIN_PART, 1024 * 1024]);

      const result = await service.completeUpload(user.id, publicId, { parts });

      expect(result).toMatchObject({ id: publicId, status: 'processing' });
      const video = await loadVideo(publicId);
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(video.upload_id).toBeNull();
      expect(video.processing_started_at).toBeInstanceOf(Date);
      expect(
        (await storage.headObject(videoOriginalKey(video.id))).contentLength,
      ).toBe(SIZE);
      expect(await processingQueue.getJobCounts('waiting')).toEqual({
        waiting: 1,
      });
      const job = await processingQueue.getJob(processVideoJobId(video.id));
      expect(job?.data).toEqual({ videoId: video.id });
    });

    it('rejects a second complete with VideoNotInDraftException and does not add another job', async () => {
      const publicId = await startUpload();
      const parts = await uploadParts(publicId, [MIN_PART, 1024 * 1024]);
      await service.completeUpload(user.id, publicId, { parts });

      await expect(
        service.completeUpload(user.id, publicId, { parts }),
      ).rejects.toBeInstanceOf(VideoNotInDraftException);

      expect(await processingQueue.getJobCounts('waiting')).toEqual({
        waiting: 1,
      });
    });

    it('turns the video into error with UPLOAD_SIZE_MISMATCH when the stored object has another size', async () => {
      const publicId = await startUpload();
      const parts = await uploadParts(publicId, [MIN_PART, 512 * 1024]);

      await expect(
        service.completeUpload(user.id, publicId, { parts }),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);

      const video = await loadVideo(publicId);
      expect(video.status).toBe(VideoStatus.ERROR);
      expect(video.error_code).toBe('UPLOAD_SIZE_MISMATCH');
      expect(await processingQueue.getJobCounts('waiting')).toEqual({
        waiting: 0,
      });
    });

    it('maps a part list rejected by the storage to InvalidUploadPartsException and keeps the draft', async () => {
      const publicId = await startUpload();
      const parts = await uploadParts(publicId, [MIN_PART, 1024 * 1024]);

      await expect(
        service.completeUpload(user.id, publicId, {
          parts: [parts[0], { part_number: 2, etag: '"deadbeef"' }],
        }),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);

      expect((await loadVideo(publicId)).status).toBe(VideoStatus.DRAFT);
    });

    it('still returns the processing video when the enqueue fails', async () => {
      const publicId = await startUpload();
      const parts = await uploadParts(publicId, [MIN_PART, 1024 * 1024]);
      jest
        .spyOn(moduleRef.get(VideoJobsProducer), 'enqueueProcessing')
        .mockRejectedValue(new Error('redis down'));
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const result = await service.completeUpload(user.id, publicId, { parts });

      expect(result.status).toBe('processing');
      expect((await loadVideo(publicId)).status).toBe(VideoStatus.PROCESSING);
    });

    it('aborts an upload: removes the row and the multipart no longer exists in the storage', async () => {
      const publicId = await startUpload();
      const video = await loadVideo(publicId);

      await service.abortUpload(user.id, publicId);

      expect(await videoCount()).toBe(0);
      await expect(
        storage.listParts(videoOriginalKey(video.id), video.upload_id!),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    });

    it('aborts an upload whose multipart is already gone from the storage', async () => {
      const publicId = await startUpload();
      const video = await loadVideo(publicId);
      await storage.abortMultipartUpload(
        videoOriginalKey(video.id),
        video.upload_id!,
      );

      await service.abortUpload(user.id, publicId);

      expect(await videoCount()).toBe(0);
    });

    it('refuses to abort a video that is already processing', async () => {
      const publicId = await startUpload();
      const parts = await uploadParts(publicId, [MIN_PART, 1024 * 1024]);
      await service.completeUpload(user.id, publicId, { parts });

      await expect(
        service.abortUpload(user.id, publicId),
      ).rejects.toBeInstanceOf(VideoNotInDraftException);
      expect(await videoCount()).toBe(1);
    });
  });

  describe('getOwnedVideo', () => {
    it('reads the real row of the caller channel as a response without upload_id', async () => {
      const { id: publicId } = await service.initiateUpload(user.id, {
        ...dto,
        size_bytes: 1024,
      });

      const result = await service.getOwnedVideo(user.id, publicId);

      expect(result).toMatchObject({
        id: publicId,
        status: VideoStatus.DRAFT,
        original_file_name: 'clip.mp4',
        size_bytes: 1024,
        duration_seconds: null,
        error_code: null,
      });
      expect(result).not.toHaveProperty('upload_id');
    });

    it('returns numbers for the numeric and bigint columns of a ready video', async () => {
      const { id: publicId } = await service.initiateUpload(user.id, {
        ...dto,
        size_bytes: 1024,
      });
      await dataSource.getRepository(Video).update(
        { public_id: publicId },
        {
          status: VideoStatus.READY,
          duration_seconds: 12.5,
          width: 1280,
          height: 720,
          bitrate_bps: 800000,
        },
      );

      const result = await service.getOwnedVideo(user.id, publicId);

      expect(result).toMatchObject({
        status: VideoStatus.READY,
        duration_seconds: 12.5,
        width: 1280,
        height: 720,
        bitrate_bps: 800000,
      });
    });

    it('answers VideoNotFoundException for another channel and for an unknown id', async () => {
      const { id: publicId } = await service.initiateUpload(user.id, {
        ...dto,
        size_bytes: 1024,
      });
      const other = await dataSource.getRepository(User).save({
        email: `videos_svc_other_${counter}@example.com`,
        password: 'hashed',
      });
      await dataSource.getRepository(Channel).save({
        name: 'Other',
        nickname: `othersvcchan${counter}`,
        user_id: other.id,
      });

      await expect(
        service.getOwnedVideo(other.id, publicId),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.getOwnedVideo(user.id, 'aaaaaaaaaaa'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
