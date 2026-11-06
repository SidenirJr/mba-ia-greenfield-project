import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

// Processo do worker: contexto de aplicação sem listener HTTP (TD-05).
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // Fecha workers e filas do BullMQ no SIGTERM/SIGINT (docker compose stop).
  app.enableShutdownHooks();
}

void bootstrap();
