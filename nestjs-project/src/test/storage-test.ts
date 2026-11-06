import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

export interface PresignedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface TestBucket {
  bucket: string;
  client: S3Client;
  cleanup: () => Promise<void>;
}

// Bucket dedicado por execução (TD-12): isola os testes do bucket de dev e é removido ao final.
export async function createTestBucket(): Promise<TestBucket> {
  const client = new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY as string,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const bucket = `test-${randomUUID()}`;
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou') throw err;
  }

  const cleanup = async () => {
    const uploads = await client.send(
      new ListMultipartUploadsCommand({ Bucket: bucket }),
    );
    for (const u of uploads.Uploads ?? []) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: u.Key,
          UploadId: u.UploadId,
        }),
      );
    }
    const objects = await client.send(
      new ListObjectsV2Command({ Bucket: bucket }),
    );
    if (objects.Contents?.length) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects.Contents.map((o) => ({ Key: o.Key })) },
        }),
      );
    }
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  };

  return { bucket, client, cleanup };
}

// Envia ao S3_ENDPOINT sobrescrevendo `host` pelo host assinado (SigV4 assina o Host).
// node:http porque o fetch (undici) pode descartar o header host customizado.
export function requestPresignedUrl(
  signedUrl: string,
  options: {
    method?: string;
    body?: Buffer;
    publicHost?: string;
    range?: string;
  } = {},
): Promise<PresignedResponse> {
  return new Promise((resolve, reject) => {
    const signed = new URL(signedUrl);
    const internal = new URL(process.env.S3_ENDPOINT as string);
    const req = request(
      {
        host: internal.hostname,
        port: internal.port,
        path: `${signed.pathname}${signed.search}`,
        method: options.method ?? 'GET',
        headers: {
          host: options.publicHost ?? signed.host,
          ...(options.range && { range: options.range }),
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
}
