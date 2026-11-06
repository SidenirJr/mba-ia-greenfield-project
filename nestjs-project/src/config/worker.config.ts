import { registerAs } from '@nestjs/config';

export default registerAs('worker', () => ({
  sweeperIntervalMs: parseInt(process.env.SWEEPER_INTERVAL_MS ?? '300000', 10),
  processingStaleMs: parseInt(process.env.PROCESSING_STALE_MS ?? '3600000', 10),
  ffmpegTimeoutMs: parseInt(process.env.FFMPEG_TIMEOUT_MS ?? '600000', 10),
}));
