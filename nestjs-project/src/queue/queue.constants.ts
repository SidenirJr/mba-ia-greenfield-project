export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_MAINTENANCE_QUEUE = 'video-maintenance';

export const VIDEO_PROCESS_JOB = 'video.process';
export const VIDEO_SWEEP_JOB = 'video.sweep';
export const VIDEO_SWEEPER_SCHEDULER_ID = 'video-sweeper';

export const PROCESSING_ATTEMPTS = 3;
export const PROCESSING_BACKOFF_DELAY_MS = 30000;
// shortcut: jitter 0.5 é o valor de exemplo da doc do BullMQ (plano só cita "jitter"); ajustar se o retry em lote exigir outra dispersão.
export const PROCESSING_BACKOFF_JITTER = 0.5;

// BullMQ proíbe ':' em jobId customizado, por isso o hífen.
export const processVideoJobId = (videoId: string): string =>
  `process-video-${videoId}`;
