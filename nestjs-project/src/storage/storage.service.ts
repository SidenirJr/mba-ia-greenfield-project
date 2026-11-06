import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_PRESIGN_CLIENT } from './storage.constants';

export interface StoredPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface PresignGetOptions {
  responseContentType?: string;
  responseContentDisposition?: string;
}

// Apenas a API S3 padrão; o API nunca carrega os bytes do upload (sem lib-storage `Upload`).
@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(S3_PRESIGN_CLIENT) private readonly presignClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    return UploadId as string;
  }

  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.presignExpiresSeconds },
    );
  }

  async listParts(key: string, uploadId: string): Promise<StoredPart[]> {
    const parts: StoredPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.s3.send(
        new ListPartsCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber as number,
          etag: part.ETag as string,
          size: part.Size as number,
        });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker !== undefined);
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.s3.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== 'NoSuchUpload') throw err;
    }
  }

  async headObject(
    key: string,
  ): Promise<{ contentLength: number; contentType?: string }> {
    const head = await this.s3.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    return {
      contentLength: head.ContentLength as number,
      contentType: head.ContentType,
    };
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  presignGetObject(
    key: string,
    options: PresignGetOptions = {},
  ): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentType: options.responseContentType,
        ResponseContentDisposition: options.responseContentDisposition,
      }),
      { expiresIn: this.config.presignExpiresSeconds },
    );
  }

  // Host interno: para ffprobe/ffmpeg dentro da rede do Compose.
  presignInternalGetObject(key: string, expiresIn: number): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn },
    );
  }
}
