import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
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
import workerConfig from '../config/worker.config';
import {
  MediaErrorCode,
  MediaProcessingError,
} from '../media/media-processing.error';
import { MediaModule } from '../media/media.module';
import { MediaToolsService } from '../media/media-tools.service';
import {
  videoOriginalKey,
  videoThumbnailKey,
} from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { createTestBucket, type TestBucket } from '../test/storage-test';
import {
  cleanupFixtures,
  generateAudioOnlyFile,
  generateCorruptFile,
  generateNonFaststartMp4,
  generateSampleVideo,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/videos.constants';
import { VideosModule } from '../videos/videos.module';
import { VideosRepository } from '../videos/videos.repository';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingService (integration)', () => {
  let testBucket: TestBucket;
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: VideoProcessingService;
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
          load: [storageConfig, uploadConfig, redisConfig, workerConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
        StorageModule,
        MediaModule,
      ],
      providers: [VideoProcessingService],
    })
      .overrideProvider(storageConfig.KEY)
      .useFactory({
        factory: () => ({ ...storageConfig(), bucket: testBucket.bucket }),
      })
      .compile();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(VideoProcessingService);
    repository = moduleRef.get(VideosRepository);
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await cleanupFixtures();
    await testBucket.cleanup();
    await moduleRef.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `processing_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Chan',
      nickname: `procchan${counter}`,
      user_id: user.id,
    });
  });

  const reload = (id: string) =>
    dataSource.getRepository(Video).findOneByOrFail({ id });

  // Vídeo `processing` cujo original já está no storage, como depois do `complete`.
  async function processingVideoWithOriginal(path?: string): Promise<Video> {
    const video = await repository.createDraft({
      channel_id: channel.id,
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      part_size: 67108864,
      part_count: 1,
      upload_expires_at: new Date(Date.now() + 3600_000),
    });
    await repository.transitionToProcessing(video.id, new Date());
    if (path) {
      await storage.putObject(
        videoOriginalKey(video.id),
        await readFile(path),
        'video/mp4',
      );
    }
    return video;
  }

  const thumbnailHead = (id: string) =>
    testBucket.client.send(
      new HeadObjectCommand({
        Bucket: testBucket.bucket,
        Key: videoThumbnailKey(id),
      }),
    );

  it('turns a processing video with a valid original into ready with metadata and a JPEG thumbnail', async () => {
    const video = await processingVideoWithOriginal(
      await generateSampleVideo({ durationSeconds: 3 }),
    );

    await service.process(video.id);

    const saved = await reload(video.id);
    expect(saved.status).toBe(VideoStatus.READY);
    expect(saved.duration_seconds).toBeCloseTo(3, 1);
    expect(saved).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
    });
    expect(saved.container_format).toContain('mp4');
    expect(saved.bitrate_bps).toBeGreaterThan(0);
    expect(JSON.stringify(saved.metadata)).not.toContain('X-Amz-Signature');
    const head = await thumbnailHead(video.id);
    expect(head.ContentType).toBe('image/jpeg');
    expect(head.ContentLength).toBeGreaterThan(0);
  });

  it('processes a non-faststart original read through the internal presigned URL', async () => {
    const video = await processingVideoWithOriginal(
      await generateNonFaststartMp4(),
    );

    await service.process(video.id);

    expect((await reload(video.id)).status).toBe(VideoStatus.READY);
  });

  it('does nothing when the same video is processed again', async () => {
    const video = await processingVideoWithOriginal(
      await generateSampleVideo(),
    );
    await service.process(video.id);
    const first = await reload(video.id);
    const probe = jest.spyOn(moduleRef.get(MediaToolsService), 'probe');

    await service.process(video.id);

    expect(probe).not.toHaveBeenCalled();
    expect(await reload(video.id)).toEqual(first);
  });

  it('marks UNREADABLE_MEDIA and rethrows a non-retryable error for a corrupt original', async () => {
    const video = await processingVideoWithOriginal(
      await generateCorruptFile(),
    );

    const error = await service.process(video.id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MediaProcessingError);
    // A mensagem entra na comparação para diagnosticar uma eventual classificação como retryable.
    const { retryable, message } = error as MediaProcessingError;
    expect({ retryable, message }).toEqual({
      retryable: false,
      message: expect.stringContaining('Media could not be read') as string,
    });
    const saved = await reload(video.id);
    expect(saved).toMatchObject({
      status: VideoStatus.ERROR,
      error_code: MediaErrorCode.UNREADABLE_MEDIA,
    });
    expect(saved.error_message).not.toContain('X-Amz-Signature');
  });

  it('marks NO_VIDEO_STREAM for an audio-only original', async () => {
    const video = await processingVideoWithOriginal(
      await generateAudioOnlyFile(),
    );

    await expect(service.process(video.id)).rejects.toMatchObject({
      code: MediaErrorCode.NO_VIDEO_STREAM,
      retryable: false,
    });

    expect(await reload(video.id)).toMatchObject({
      status: VideoStatus.ERROR,
      error_code: MediaErrorCode.NO_VIDEO_STREAM,
    });
  });

  it('marks THUMBNAIL_FAILED, never ready, when the thumbnail step fails after the metadata succeeded', async () => {
    const video = await processingVideoWithOriginal(
      await generateSampleVideo(),
    );
    jest
      .spyOn(moduleRef.get(MediaToolsService), 'extractThumbnail')
      .mockRejectedValue(
        new MediaProcessingError(
          MediaErrorCode.THUMBNAIL_FAILED,
          'no frame',
          false,
        ),
      );

    await expect(service.process(video.id)).rejects.toMatchObject({
      code: MediaErrorCode.THUMBNAIL_FAILED,
    });

    expect(await reload(video.id)).toMatchObject({
      status: VideoStatus.ERROR,
      error_code: MediaErrorCode.THUMBNAIL_FAILED,
      duration_seconds: null,
    });
  });

  it('keeps the video processing and propagates a retryable error when the original cannot be read', async () => {
    const video = await processingVideoWithOriginal();

    const error = await service.process(video.id).catch((e: unknown) => e);

    expect(error).toMatchObject({ retryable: true });
    expect((await reload(video.id)).status).toBe(VideoStatus.PROCESSING);
  });

  it('keeps the video processing when the thumbnail upload fails on storage', async () => {
    const video = await processingVideoWithOriginal(
      await generateSampleVideo(),
    );
    const failure = new Error('storage down');
    jest.spyOn(storage, 'putObject').mockRejectedValue(failure);

    await expect(service.process(video.id)).rejects.toBe(failure);

    expect((await reload(video.id)).status).toBe(VideoStatus.PROCESSING);
  });
});
