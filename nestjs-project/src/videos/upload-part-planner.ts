import { MAX_PARTS, MIN_PART_SIZE } from './videos.constants';

export interface UploadPartPlan {
  partSize: number;
  partCount: number;
}

export function planUploadParts(
  sizeBytes: number,
  configuredPartSize: number,
): UploadPartPlan {
  const partSize = Math.max(
    configuredPartSize,
    MIN_PART_SIZE,
    Math.ceil(sizeBytes / MAX_PARTS),
  );
  return { partSize, partCount: Math.ceil(sizeBytes / partSize) };
}
