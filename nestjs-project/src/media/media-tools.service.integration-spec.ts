import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import workerConfig from '../config/worker.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanupFixtures,
  generateAudioOnlyFile,
  generateCorruptFile,
  generateNonFaststartMp4,
  generateSampleVideo,
} from '../test/video-fixtures';
import { createTestBucket, type TestBucket } from '../test/storage-test';
import { MediaErrorCode, MediaProcessingError } from './media-processing.error';
import { MediaModule } from './media.module';
import { MediaToolsService } from './media-tools.service';

const INTERNAL_URL_TTL_SECONDS = 600;

async function createModule(
  bucket: string,
  ffmpegTimeoutMs?: number,
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [storageConfig, workerConfig],
      }),
      StorageModule,
      MediaModule,
    ],
  })
    .overrideProvider(storageConfig.KEY)
    .useFactory({ factory: () => ({ ...storageConfig(), bucket }) })
    .overrideProvider(workerConfig.KEY)
    .useFactory({
      factory: () => ({
        ...workerConfig(),
        ...(ffmpegTimeoutMs !== undefined && { ffmpegTimeoutMs }),
      }),
    })
    .compile();
}

describe('MediaToolsService (integration)', () => {
  let testBucket: TestBucket;
  let moduleRef: TestingModule;
  let media: MediaToolsService;
  let storage: StorageService;
  let keyCounter = 0;

  beforeAll(async () => {
    testBucket = await createTestBucket();
    moduleRef = await createModule(testBucket.bucket);
    media = moduleRef.get(MediaToolsService);
    storage = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await cleanupFixtures();
    await testBucket.cleanup();
    await moduleRef.close();
  });

  async function internalUrlOf(path: string): Promise<string> {
    const key = `videos/media-${++keyCounter}/original`;
    await storage.putObject(key, await readFile(path), 'video/mp4');
    return storage.presignInternalGetObject(key, INTERNAL_URL_TTL_SECONDS);
  }

  const rejection = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (err) {
      return err as MediaProcessingError;
    }
    throw new Error('expected the promise to reject');
  };

  it('probes a valid MP4 with coherent metadata', async () => {
    const path = await generateSampleVideo({ durationSeconds: 2 });

    const result = await media.probe(path);

    expect(result.durationSeconds).toBeCloseTo(2, 1);
    expect(result).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
    });
    expect(result.containerFormat).toContain('mp4');
    expect(result.bitrateBps).toBeGreaterThan(0);
  });

  it('probes a non-faststart MP4 through the internal presigned URL with the same metadata as the local file', async () => {
    const path = await generateNonFaststartMp4();
    const url = await internalUrlOf(path);

    const viaUrl = await media.probe(url);

    expect(viaUrl).toEqual(await media.probe(path));
    expect(JSON.stringify(viaUrl.metadata)).not.toContain('X-Amz-Signature');
  });

  it('fails a corrupt file with a non-retryable UNREADABLE_MEDIA that does not leak the signed URL', async () => {
    const url = await internalUrlOf(await generateCorruptFile());

    const error = await rejection(media.probe(url));

    expect(error).toBeInstanceOf(MediaProcessingError);
    expect(error).toMatchObject({
      code: MediaErrorCode.UNREADABLE_MEDIA,
      retryable: false,
    });
    expect(error.message).not.toContain('X-Amz-Signature');
  });

  it('fails an audio-only file with a non-retryable NO_VIDEO_STREAM', async () => {
    const error = await rejection(media.probe(await generateAudioOnlyFile()));

    expect(error).toMatchObject({
      code: MediaErrorCode.NO_VIDEO_STREAM,
      retryable: false,
    });
  });

  it('fails retryably when the object cannot be fetched (missing key)', async () => {
    const url = await storage.presignInternalGetObject(
      'videos/does-not-exist/original',
      INTERNAL_URL_TTL_SECONDS,
    );

    const error = await rejection(media.probe(url));

    expect(error).toMatchObject({
      code: MediaErrorCode.TRANSIENT,
      retryable: true,
    });
    expect(error.message).not.toContain('X-Amz-Signature');
  });

  describe('extractThumbnail', () => {
    // O JPEG baseline traz SOF0 (FFC0) com altura e largura em big-endian.
    const jpegSize = (jpeg: Buffer): { width: number; height: number } => {
      const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
      return {
        height: jpeg.readUInt16BE(sof + 5),
        width: jpeg.readUInt16BE(sof + 7),
      };
    };

    it('returns a JPEG no wider than 1280 with an even height', async () => {
      const path = await generateSampleVideo({ durationSeconds: 3 });
      const url = await internalUrlOf(path);

      const jpeg = await media.extractThumbnail(url, 3);

      expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      const { width, height } = jpegSize(jpeg);
      expect(width).toBeLessThanOrEqual(1280);
      expect(height % 2).toBe(0);
    });

    it('extracts a frame from a 0.5 s video', async () => {
      const path = await generateSampleVideo({ durationSeconds: 0.5 });

      const jpeg = await media.extractThumbnail(path, 0.5);

      expect(jpeg.length).toBeGreaterThan(0);
      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    });

    it('fails a corrupt file with a non-retryable THUMBNAIL_FAILED', async () => {
      const error = await rejection(
        media.extractThumbnail(await generateCorruptFile(), 5),
      );

      expect(error).toMatchObject({
        code: MediaErrorCode.THUMBNAIL_FAILED,
        retryable: false,
      });
    });
  });

  describe('timeout', () => {
    let hangingServer: Server;
    let hangingUrl: string;
    let shortTimeoutModule: TestingModule;

    beforeAll(async () => {
      // Servidor que aceita a conexão e nunca responde: o ffprobe só termina pelo timeout.
      hangingServer = createServer(() => undefined);
      await new Promise<void>((resolve) =>
        hangingServer.listen(0, '127.0.0.1', resolve),
      );
      hangingUrl = `http://127.0.0.1:${(hangingServer.address() as AddressInfo).port}/video.mp4`;
      shortTimeoutModule = await createModule(testBucket.bucket, 500);
    });

    afterAll(async () => {
      hangingServer.closeAllConnections();
      await new Promise((resolve) => hangingServer.close(resolve));
      await shortTimeoutModule.close();
    });

    it.each(['probe', 'extractThumbnail'] as const)(
      'turns a %s that exceeds the process timeout into a retryable error',
      async (method) => {
        const tools = shortTimeoutModule.get(MediaToolsService);

        const error = await rejection(
          method === 'probe'
            ? tools.probe(hangingUrl)
            : tools.extractThumbnail(hangingUrl, 5),
        );

        expect(error).toMatchObject({
          code: MediaErrorCode.TRANSIENT,
          retryable: true,
        });
        expect(error.message).toContain('timed out');
      },
    );
  });
});
