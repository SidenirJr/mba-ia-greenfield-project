import request from 'supertest';
import { Video } from '../src/videos/entities/video.entity';
import { Channel } from '../src/channels/entities/channel.entity';
import { User } from '../src/users/entities/user.entity';
import uploadConfig from '../src/config/upload.config';
import {
  createVideosE2eApp,
  E2E_PART_SIZE_BYTES,
  registerConfirmAndLogin,
  type VideosE2eApp,
} from '../src/test/videos-e2e-app';

interface InitiateBody {
  id: string;
  status: string;
  part_size: number;
  part_count: number;
  expires_at: string;
  statusCode: number;
  error: string;
  message: string | string[];
}

describe('videos-initiate-upload', () => {
  let ctx: VideosE2eApp;
  let ownerToken: string;
  let ownerChannelId: string;

  const validBody = {
    file_name: 'sample.mp4',
    size_bytes: 6291456,
    content_type: 'video/mp4',
  };
  const post = (body: object, token?: string) => {
    const req = request(ctx.app.getHttpServer()).post('/videos');
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
      body,
    );
  };
  const videoCount = () => ctx.dataSource.getRepository(Video).count();

  beforeAll(async () => {
    ctx = await createVideosE2eApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ownerToken = await registerConfirmAndLogin(ctx.app, 'owner@example.com');
    await registerConfirmAndLogin(ctx.app, 'other@example.com');
    const owner = await ctx.dataSource
      .getRepository(User)
      .findOneByOrFail({ email: 'owner@example.com' });
    ownerChannelId = (
      await ctx.dataSource
        .getRepository(Channel)
        .findOneByOrFail({ user_id: owner.id })
    ).id;
  });

  // 1. POST /videos — iniciar upload

  it('initiate-upload-returns-draft-and-part-plan', async () => {
    const res = await post(validBody, ownerToken).expect(201);

    const body = res.body as InitiateBody;
    expect(body.id).toMatch(/^[0-9A-Za-z]{11}$/);
    expect(body.status).toBe('draft');
    expect(body.part_size).toBe(E2E_PART_SIZE_BYTES);
    expect(body.part_count).toBe(2);
    expect(new Date(body.expires_at).toISOString()).toBe(body.expires_at);
    const rows = await ctx.dataSource.getRepository(Video).find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      public_id: body.id,
      status: 'draft',
      channel_id: ownerChannelId,
    });
    expect(rows[0].upload_id).toEqual(expect.any(String));
  });

  it('initiate-upload-without-token-returns-401', async () => {
    await post(validBody).expect(401);

    expect(await videoCount()).toBe(0);
  });

  it('initiate-upload-size-over-limit-returns-413', async () => {
    const res = await post(
      { ...validBody, size_bytes: uploadConfig().maxBytes + 1 },
      ownerToken,
    ).expect(413);

    expect(res.body).toMatchObject({
      statusCode: 413,
      error: 'UPLOAD_SIZE_EXCEEDS_LIMIT',
      message: expect.any(String) as string,
    });
    expect(await videoCount()).toBe(0);
  });

  it('initiate-upload-non-video-content-type-returns-415', async () => {
    const res = await post(
      { ...validBody, content_type: 'application/pdf' },
      ownerToken,
    ).expect(415);

    expect((res.body as InitiateBody).error).toBe('INVALID_CONTENT_TYPE');
    expect(await videoCount()).toBe(0);
  });

  it('initiate-upload-invalid-body-returns-400', async () => {
    const missing = await post(
      { size_bytes: 6291456, content_type: 'video/mp4' },
      ownerToken,
    ).expect(400);
    expect((missing.body as InitiateBody).error).toBe('VALIDATION_ERROR');
    expect(Array.isArray((missing.body as InitiateBody).message)).toBe(true);

    const extra = await post({ ...validBody, foo: 'bar' }, ownerToken).expect(
      400,
    );
    expect((extra.body as InitiateBody).error).toBe('VALIDATION_ERROR');
    expect(await videoCount()).toBe(0);
  });
});
