import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { DomainExceptionFilter } from '../common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../common/filters/validation-exception.filter';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import { MailService } from '../mail/mail.service';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { cleanAllTables } from './create-test-data-source';
import { obliterateQueues, uniqueQueuePrefix } from './queue-test';
import { createTestBucket, type TestBucket } from './storage-test';

export const E2E_PART_SIZE_BYTES = 5 * 1024 * 1024;

export interface VideosE2eApp {
  app: INestApplication<App>;
  moduleRef: TestingModule;
  dataSource: DataSource;
  testBucket: TestBucket;
  processingQueue: Queue;
  // Zera o estado entre testes: tabelas, contador do throttler e fila do prefixo exclusivo.
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

// Replica o bootstrap do main.ts com um bucket e um prefixo de fila exclusivos da suíte (TD-12).
export async function createVideosE2eApp(): Promise<VideosE2eApp> {
  process.env.UPLOAD_PART_SIZE_BYTES = String(E2E_PART_SIZE_BYTES);
  const testBucket = await createTestBucket();
  const queuePrefix = uniqueQueuePrefix();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(storageConfig.KEY)
    .useFactory({
      factory: () => ({ ...storageConfig(), bucket: testBucket.bucket }),
    })
    .overrideProvider(redisConfig.KEY)
    .useFactory({ factory: () => ({ ...redisConfig(), queuePrefix }) })
    .compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  const dataSource = moduleRef.get(DataSource);
  const throttlerStorage =
    moduleRef.get<ThrottlerStorageService>(ThrottlerStorage);
  const processingQueue = moduleRef.get<Queue>(
    getQueueToken(VIDEO_PROCESSING_QUEUE),
  );

  return {
    app,
    moduleRef,
    dataSource,
    testBucket,
    processingQueue,
    reset: async () => {
      await cleanAllTables(dataSource);
      throttlerStorage.storage.clear();
      await obliterateQueues(processingQueue);
    },
    close: async () => {
      await obliterateQueues(processingQueue);
      await app.close();
      await testBucket.cleanup();
    },
  };
}

// Cadastra, confirma o e-mail (capturando o token pelo spy) e faz login; devolve o access token.
export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  const mailService = app.get(MailService);
  let token = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, t: string) => {
      token = t;
      return Promise.resolve();
    });
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password });
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token });
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password });
  return (res.body as { access_token: string }).access_token;
}
