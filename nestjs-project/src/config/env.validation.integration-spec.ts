import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
  S3_BUCKET: 'bucket',
};

const validateWithout = (missing: keyof typeof requiredEnv) => {
  const env: Record<string, string> = { ...requiredEnv };
  delete env[missing];
  return envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  });
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect((result.value as { SWAGGER_ENABLED: string }).SWAGGER_ENABLED).toBe(
      'false',
    );
  });
});

describe('envValidationSchema — storage, redis, upload e worker', () => {
  it.each(['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET'] as const)(
    'should reject a missing %s',
    (name) => {
      const { error } = validateWithout(name);
      expect(error).toBeDefined();
      expect(error!.message).toContain(name);
    },
  );

  it('should apply defaults when only the required variables are set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect(result.value as object).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'true',
      PRESIGN_EXPIRES_SECONDS: 900,
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'streamtube',
      UPLOAD_MAX_BYTES: 10737418240,
      UPLOAD_PART_SIZE_BYTES: 67108864,
      UPLOAD_EXPIRATION_HOURS: 24,
      SWEEPER_INTERVAL_MS: 300000,
      PROCESSING_STALE_MS: 3600000,
      FFMPEG_TIMEOUT_MS: 600000,
    });
  });

  it.each([
    ['UPLOAD_MAX_BYTES', '0'],
    ['UPLOAD_PART_SIZE_BYTES', '-1'],
    ['SWEEPER_INTERVAL_MS', 'abc'],
    ['PROCESSING_STALE_MS', '0'],
    ['FFMPEG_TIMEOUT_MS', 'abc'],
    ['PRESIGN_EXPIRES_SECONDS', '0'],
    ['S3_FORCE_PATH_STYLE', 'yes'],
  ])('should reject %s=%s citing the variable', (name, invalid) => {
    const { error } = validate({ [name]: invalid });
    expect(error).toBeDefined();
    expect(error!.message).toContain(name);
  });

  it('should accept explicit valid overrides', () => {
    const result = validate({
      UPLOAD_MAX_BYTES: '1048576',
      S3_FORCE_PATH_STYLE: 'false',
    });
    expect(result.error).toBeUndefined();
    expect(result.value as object).toMatchObject({
      UPLOAD_MAX_BYTES: 1048576,
      S3_FORCE_PATH_STYLE: 'false',
    });
  });
});
