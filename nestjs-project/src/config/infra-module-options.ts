import { ConfigModule, ConfigModuleOptions, ConfigType } from '@nestjs/config';
import type { TypeOrmModuleAsyncOptions } from '@nestjs/typeorm';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import { envValidationSchema } from './env.validation';
import mailConfig from './mail.config';
import redisConfig from './redis.config';
import storageConfig from './storage.config';
import swaggerConfig from './swagger.config';
import uploadConfig from './upload.config';
import workerConfig from './worker.config';

// Compartilhado pelo AppModule e pelo WorkerModule: dois processos, mesma configuração e mesmo Joi, sem divergência.
export const configModuleOptions: ConfigModuleOptions = {
  isGlobal: true,
  load: [
    appConfig,
    authConfig,
    databaseConfig,
    mailConfig,
    swaggerConfig,
    storageConfig,
    redisConfig,
    uploadConfig,
    workerConfig,
  ],
  validationSchema: envValidationSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
};

export const typeOrmAsyncOptions: TypeOrmModuleAsyncOptions = {
  imports: [ConfigModule],
  inject: [databaseConfig.KEY],
  useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    autoLoadEntities: true,
    synchronize: false,
  }),
};
