export const VideoStatus = {
  DRAFT: 'draft',
  PROCESSING: 'processing',
  READY: 'ready',
  ERROR: 'error',
} as const;

export type VideoStatus = (typeof VideoStatus)[keyof typeof VideoStatus];
