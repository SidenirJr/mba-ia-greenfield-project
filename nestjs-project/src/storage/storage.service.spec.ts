import { S3Client } from '@aws-sdk/client-s3';
import { videoOriginalKey, videoThumbnailKey } from './storage.constants';
import { StorageService } from './storage.service';

const config = {
  endpoint: 'http://internal.test:9000',
  publicEndpoint: 'http://public.test:9000',
  region: 'us-east-1',
  accessKeyId: 'key',
  secretAccessKey: 'secret-key',
  bucket: 'bucket',
  forcePathStyle: true,
  presignExpiresSeconds: 600,
};

const realClient = (endpoint: string) =>
  new S3Client({
    region: config.region,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });

describe('StorageService', () => {
  describe('presigned URLs (real SDK, local signing)', () => {
    const service = new StorageService(
      realClient(config.endpoint),
      realClient(config.publicEndpoint),
      config,
    );

    it('should sign an upload part for the public host with expiry, part number and upload id', async () => {
      const url = new URL(
        await service.presignUploadPart('videos/abc/original', 'upload-1', 3),
      );

      expect(url.host).toBe('public.test:9000');
      expect(url.pathname).toBe('/bucket/videos/abc/original');
      expect(url.searchParams.get('partNumber')).toBe('3');
      expect(url.searchParams.get('uploadId')).toBe('upload-1');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    });

    it('should sign a GET with response content disposition and type for the public host', async () => {
      const url = new URL(
        await service.presignGetObject('videos/abc/original', {
          responseContentType: 'video/mp4',
          responseContentDisposition: 'attachment; filename="a.mp4"',
        }),
      );

      expect(url.host).toBe('public.test:9000');
      expect(url.searchParams.get('response-content-disposition')).toBe(
        'attachment; filename="a.mp4"',
      );
      expect(url.searchParams.get('response-content-type')).toBe('video/mp4');
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    });

    it('should sign an internal GET for the internal host with the given expiry', async () => {
      const url = new URL(
        await service.presignInternalGetObject('videos/abc/original', 1200),
      );

      expect(url.host).toBe('internal.test:9000');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('1200');
    });
  });

  describe('listParts pagination', () => {
    it('should follow PartNumberMarker until the listing is no longer truncated', async () => {
      const send = jest
        .fn()
        .mockResolvedValueOnce({
          Parts: [{ PartNumber: 1, ETag: '"a"', Size: 5 }],
          IsTruncated: true,
          NextPartNumberMarker: '1',
        })
        .mockResolvedValueOnce({
          Parts: [{ PartNumber: 2, ETag: '"b"', Size: 7 }],
          IsTruncated: false,
        });
      const service = new StorageService(
        { send } as unknown as S3Client,
        {} as S3Client,
        config,
      );

      const parts = await service.listParts('k', 'u');

      expect(parts).toEqual([
        { partNumber: 1, etag: '"a"', size: 5 },
        { partNumber: 2, etag: '"b"', size: 7 },
      ]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(
        (send.mock.calls[1] as [{ input: { PartNumberMarker: string } }])[0]
          .input.PartNumberMarker,
      ).toBe('1');
    });
  });

  describe('abortMultipartUpload', () => {
    const serviceFailingWith = (name: string) =>
      new StorageService(
        {
          send: jest
            .fn()
            .mockRejectedValue(Object.assign(new Error(), { name })),
        } as unknown as S3Client,
        {} as S3Client,
        config,
      );

    it('should tolerate NoSuchUpload', async () => {
      await expect(
        serviceFailingWith('NoSuchUpload').abortMultipartUpload('k', 'u'),
      ).resolves.toBeUndefined();
    });

    it('should rethrow other errors', async () => {
      await expect(
        serviceFailingWith('AccessDenied').abortMultipartUpload('k', 'u'),
      ).rejects.toMatchObject({ name: 'AccessDenied' });
    });
  });

  describe('object keys', () => {
    it('should derive deterministic keys from the internal video id', () => {
      expect(videoOriginalKey('id-1')).toBe('videos/id-1/original');
      expect(videoThumbnailKey('id-1')).toBe('videos/id-1/thumbnail.jpg');
    });
  });
});
