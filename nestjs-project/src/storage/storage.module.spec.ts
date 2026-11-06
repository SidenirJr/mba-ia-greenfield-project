import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_PRESIGN_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  const config = {
    endpoint: 'http://internal.test:9000',
    publicEndpoint: 'http://public.test:9000',
    region: 'us-east-1',
    accessKeyId: 'key',
    secretAccessKey: 'secret-key',
    bucket: 'bucket',
    forcePathStyle: true,
    presignExpiresSeconds: 900,
  };

  it('should provide two distinct S3 clients, one per endpoint, and export StorageService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(config)
      .compile();

    const internal = moduleRef.get<S3Client>(S3_CLIENT);
    const presign = moduleRef.get<S3Client>(S3_PRESIGN_CLIENT);

    expect(internal).not.toBe(presign);
    expect((await internal.config.endpoint?.())?.hostname).toBe(
      'internal.test',
    );
    expect((await presign.config.endpoint?.())?.hostname).toBe('public.test');
    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);
    await moduleRef.close();
  });
});
