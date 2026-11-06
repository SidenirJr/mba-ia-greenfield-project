import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  createTestBucket,
  requestPresignedUrl,
  type TestBucket,
} from '../test/storage-test';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIN_PART = 5 * 1024 * 1024;

describe('StorageService (integration)', () => {
  let testBucket: TestBucket;
  let service: StorageService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    testBucket = await createTestBucket();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useFactory({
        factory: () => ({
          ...storageConfig(),
          bucket: testBucket.bucket,
          presignExpiresSeconds: 300,
        }),
      })
      .compile();
    service = moduleRef.get(StorageService);
    close = () => moduleRef.close();
  });

  afterAll(async () => {
    await testBucket.cleanup();
    await close();
  });

  const uploadPart = async (
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ) => {
    const url = await service.presignUploadPart(key, uploadId, partNumber);
    const res = await requestPresignedUrl(url, { method: 'PUT', body });
    expect(res.status).toBe(200);
    return res.headers.etag as string;
  };

  it('should complete a 2-part multipart upload through presigned part URLs, list parts and head the object', async () => {
    const key = 'videos/it-multipart/original';
    const part1 = Buffer.alloc(MIN_PART, 1);
    const part2 = Buffer.alloc(1024, 2);
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    const etag1 = await uploadPart(key, uploadId, 1, part1);
    const etag2 = await uploadPart(key, uploadId, 2, part2);

    const listed = await service.listParts(key, uploadId);
    expect(listed).toEqual([
      { partNumber: 1, etag: etag1, size: MIN_PART },
      { partNumber: 2, etag: etag2, size: 1024 },
    ]);

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag1 },
      { partNumber: 2, etag: etag2 },
    ]);

    await expect(service.headObject(key)).resolves.toEqual({
      contentLength: MIN_PART + 1024,
      contentType: 'video/mp4',
    });
  });

  it('should tolerate aborting an upload that does not exist and abort a real one', async () => {
    const key = 'videos/it-abort/original';
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    await service.abortMultipartUpload(key, uploadId);

    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
    await expect(service.listParts(key, uploadId)).rejects.toMatchObject({
      name: 'NoSuchUpload',
    });
  });

  it('should store an object with putObject and serve it through the internal presigned URL directly', async () => {
    const key = 'videos/it-put/thumbnail.jpg';
    const body = Buffer.from('jpeg-bytes');

    await service.putObject(key, body, 'image/jpeg');
    const url = await service.presignInternalGetObject(key, 300);
    const res = await fetch(url);

    expect(new URL(url).host).toBe(new URL(process.env.S3_ENDPOINT!).host);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('should serve the public presigned GET with the response content disposition', async () => {
    const key = 'videos/it-put/thumbnail.jpg';
    const url = await service.presignGetObject(key, {
      responseContentDisposition: 'attachment; filename="t.jpg"',
    });

    const res = await requestPresignedUrl(url);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="t.jpg"',
    );
  });
});
