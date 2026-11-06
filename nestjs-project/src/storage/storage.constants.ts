export const S3_CLIENT = Symbol('S3_CLIENT');
export const S3_PRESIGN_CLIENT = Symbol('S3_PRESIGN_CLIENT');

export const videoOriginalKey = (id: string): string => `videos/${id}/original`;

export const videoThumbnailKey = (id: string): string =>
  `videos/${id}/thumbnail.jpg`;
