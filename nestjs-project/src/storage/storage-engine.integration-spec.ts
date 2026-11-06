import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Contrato S3 da engine de storage (pgsty/silo) com clientes crus: sem código de aplicação.
const endpoint = process.env.S3_ENDPOINT as string;
const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT as string;
const bucket = process.env.S3_BUCKET as string;

const clientConfig = (url: string) => ({
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint: url,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED' as const,
  responseChecksumValidation: 'WHEN_REQUIRED' as const,
});

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

// Envia ao endpoint interno sobrescrevendo `host` pelo host público assinado (SigV4 assina o Host).
// node:http porque o fetch (undici) pode descartar o header host customizado.
const sendToInternal = (
  signedUrl: string,
  options: { method: string; headers?: Record<string, string>; body?: Buffer },
): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const signed = new URL(signedUrl);
    const internal = new URL(endpoint);
    const req = request(
      {
        host: internal.hostname,
        port: internal.port,
        path: `${signed.pathname}${signed.search}`,
        method: options.method,
        headers: {
          ...options.headers,
          host: signed.host,
          ...(options.body && { 'content-length': options.body.length }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode as number,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });

describe('Storage engine contract (S3 API)', () => {
  const internal = new S3Client(clientConfig(endpoint));
  const publicSigner = new S3Client(clientConfig(publicEndpoint));
  const keyPrefix = `contract-test/${randomUUID()}`;
  const createdKeys: string[] = [];

  const newKey = (name: string) => {
    const key = `${keyPrefix}/${name}`;
    createdKeys.push(key);
    return key;
  };

  const presignPart = (key: string, uploadId: string, partNumber: number) =>
    getSignedUrl(
      publicSigner,
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: 300 },
    );

  const uploadPart = async (
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ) => {
    const res = await sendToInternal(
      await presignPart(key, uploadId, partNumber),
      { method: 'PUT', body },
    );
    expect(res.status).toBe(200);
    return res.headers.etag as string;
  };

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((Key) =>
        internal.send(new DeleteObjectCommand({ Bucket: bucket, Key })),
      ),
    );
    internal.destroy();
    publicSigner.destroy();
  });

  it('should complete a 2-part multipart upload via presigned part URLs signed for the public host', async () => {
    const key = newKey('multipart.bin');
    const part1 = Buffer.alloc(5 * 1024 * 1024, 1);
    const part2 = Buffer.alloc(1024, 2);

    const { UploadId } = await internal.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: 'video/mp4',
      }),
    );
    const etag1 = await uploadPart(key, UploadId as string, 1, part1);
    const etag2 = await uploadPart(key, UploadId as string, 2, part2);

    await internal.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        MultipartUpload: {
          Parts: [
            { ETag: etag1, PartNumber: 1 },
            { ETag: etag2, PartNumber: 2 },
          ],
        },
      }),
    );

    const head = await internal.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    expect(head.ContentLength).toBe(part1.length + part2.length);
    expect(head.ContentType).toBe('video/mp4');
  });

  it('should list uploaded parts with ETag and stop listing the upload after abort', async () => {
    const key = newKey('listparts.bin');
    const { UploadId } = await internal.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    );
    const etag1 = await uploadPart(
      key,
      UploadId as string,
      1,
      Buffer.alloc(5 * 1024 * 1024, 3),
    );

    const listed = await internal.send(
      new ListPartsCommand({ Bucket: bucket, Key: key, UploadId }),
    );
    expect(listed.Parts).toHaveLength(1);
    expect(listed.Parts?.[0]).toMatchObject({
      PartNumber: 1,
      Size: 5 * 1024 * 1024,
      ETag: etag1,
    });

    await internal.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
      }),
    );
    const uploads = await internal.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
    );
    expect(uploads.Uploads ?? []).toHaveLength(0);
  });

  describe('presigned GET', () => {
    const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    let key: string;

    beforeAll(async () => {
      key = newKey('object.bin');
      const { UploadId } = await internal.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
      );
      // Parte única (a última parte é isenta do mínimo de 5 MiB)
      const etag = await uploadPart(key, UploadId as string, 1, body);
      await internal.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId,
          MultipartUpload: { Parts: [{ ETag: etag, PartNumber: 1 }] },
        }),
      );
    });

    it('should answer Range requests with 206, Content-Range and Accept-Ranges', async () => {
      const url = await getSignedUrl(
        publicSigner,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: 300 },
      );

      const res = await sendToInternal(url, {
        method: 'GET',
        headers: { range: 'bytes=0-99' },
      });

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes 0-99/${body.length}`);
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.body.equals(body.subarray(0, 100))).toBe(true);
    });

    it('should emit Content-Disposition from ResponseContentDisposition', async () => {
      const url = await getSignedUrl(
        publicSigner,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: 'attachment; filename="video.mp4"',
        }),
        { expiresIn: 300 },
      );

      const res = await sendToInternal(url, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="video.mp4"',
      );
    });
  });

  it('should answer a CORS preflight exposing ETag', async () => {
    const url = new URL(`${endpoint}/${bucket}/${keyPrefix}/cors-probe`);

    const res = await new Promise<HttpResult>((resolve, reject) => {
      const req = request(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'OPTIONS',
          headers: {
            origin: 'http://localhost:3001',
            'access-control-request-method': 'PUT',
          },
        },
        (r) => {
          r.resume();
          r.on('end', () =>
            resolve({
              status: r.statusCode as number,
              headers: r.headers,
              body: Buffer.alloc(0),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(res.status).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBeDefined();
    expect(String(res.headers['access-control-expose-headers'])).toContain(
      'ETag',
    );
  });
});
