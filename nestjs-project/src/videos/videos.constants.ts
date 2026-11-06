export const VideoStatus = {
  DRAFT: 'draft',
  PROCESSING: 'processing',
  READY: 'ready',
  ERROR: 'error',
} as const;

export type VideoStatus = (typeof VideoStatus)[keyof typeof VideoStatus];

export const VIDEO_PUBLIC_ID_LENGTH = 11;

export const MIN_PART_SIZE = 5 * 1024 * 1024;
export const MAX_PARTS = 10000;
