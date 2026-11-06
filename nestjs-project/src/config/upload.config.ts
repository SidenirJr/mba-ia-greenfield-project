import { registerAs } from '@nestjs/config';

export default registerAs('upload', () => ({
  maxBytes: parseInt(process.env.UPLOAD_MAX_BYTES ?? '10737418240', 10),
  partSizeBytes: parseInt(process.env.UPLOAD_PART_SIZE_BYTES ?? '67108864', 10),
  expirationHours: parseInt(process.env.UPLOAD_EXPIRATION_HOURS ?? '24', 10),
}));
