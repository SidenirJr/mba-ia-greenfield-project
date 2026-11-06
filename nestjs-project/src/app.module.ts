import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { VideosModule } from './videos/videos.module';
import {
  configModuleOptions,
  typeOrmAsyncOptions,
} from './config/infra-module-options';

// Só o lado produtor da fila (via VideosModule → QueueModule): o WorkerModule, único com @Processor, nunca é importado aqui (TD-05).
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeOrmAsyncOptions),
    AuthModule,
    VideosModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
