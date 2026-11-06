import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_PRESIGN_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

// Checksums WHEN_REQUIRED: a engine S3-compatível e os PUTs pré-assinados feitos por navegadores não esperam o CRC32 do default do SDK (TD-03).
const clientOptions = (config: ConfigType<typeof storageConfig>) => ({
  region: config.region,
  credentials: {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED' as const,
  responseChecksumValidation: 'WHEN_REQUIRED' as const,
});

@Module({
  providers: [
    {
      provide: S3_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        new S3Client({
          ...clientOptions(config),
          endpoint: config.endpoint,
          forcePathStyle: config.forcePathStyle,
        }),
    },
    {
      // Só assina URLs para o host público; a assinatura é local (sem rede).
      provide: S3_PRESIGN_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        new S3Client({
          ...clientOptions(config),
          endpoint: config.publicEndpoint,
          forcePathStyle: true,
        }),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
