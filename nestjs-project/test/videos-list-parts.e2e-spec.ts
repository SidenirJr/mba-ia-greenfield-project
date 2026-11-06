import request from 'supertest';
import {
  createVideosE2eApp,
  E2E_PART_SIZE_BYTES,
  registerConfirmAndLogin,
  type VideosE2eApp,
} from '../src/test/videos-e2e-app';
import { requestPresignedUrl } from '../src/test/storage-test';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/videos.constants';

interface PartsBody {
  part_size: number;
  part_count: number;
  parts: { part_number: number; size: number; etag: string }[];
  error: string;
}

describe('videos-list-parts', () => {
  let ctx: VideosE2eApp;
  let ownerToken: string;
  let otherToken: string;
  let videoId: string;

  const getParts = (token?: string) => {
    const req = request(ctx.app.getHttpServer()).get(
      `/videos/${videoId}/upload/parts`,
    );
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  beforeAll(async () => {
    ctx = await createVideosE2eApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  // Cada cenário parte de um rascunho do dono de 2 partes (6 MiB com partes de 5 MiB).
  beforeEach(async () => {
    await ctx.reset();
    ownerToken = await registerConfirmAndLogin(ctx.app, 'owner@example.com');
    otherToken = await registerConfirmAndLogin(ctx.app, 'other@example.com');
    const res = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        file_name: 'sample.mp4',
        size_bytes: 6291456,
        content_type: 'video/mp4',
      })
      .expect(201);
    videoId = (res.body as { id: string }).id;
  });

  // 1. GET /videos/:id/upload/parts — retomada

  it('lists-uploaded-part-after-put', async () => {
    const urls = await request(ctx.app.getHttpServer())
      .post(`/videos/${videoId}/upload/part-urls`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const { url } = (urls.body as { parts: { url: string }[] }).parts[0];
    const put = await requestPresignedUrl(url, {
      method: 'PUT',
      body: Buffer.alloc(E2E_PART_SIZE_BYTES, 1),
    });
    expect(put.status).toBe(200);
    const etag = put.headers.etag as string;
    expect(etag).toBeDefined();

    const res = await getParts(ownerToken).expect(200);

    const body = res.body as PartsBody;
    expect(body.part_size).toBe(E2E_PART_SIZE_BYTES);
    expect(body.part_count).toBe(2);
    expect(body.parts).toEqual([
      { part_number: 1, size: E2E_PART_SIZE_BYTES, etag },
    ]);
  });

  it('lists-empty-parts-before-any-upload', async () => {
    const res = await getParts(ownerToken).expect(200);

    expect((res.body as PartsBody).parts).toEqual([]);
  });

  it('other-user-gets-404', async () => {
    const res = await getParts(otherToken).expect(404);

    expect((res.body as PartsBody).error).toBe('VIDEO_NOT_FOUND');
  });

  it('not-in-draft-returns-409', async () => {
    await ctx.dataSource
      .getRepository(Video)
      .update({ public_id: videoId }, { status: VideoStatus.PROCESSING });

    const res = await getParts(ownerToken).expect(409);

    expect((res.body as PartsBody).error).toBe('VIDEO_NOT_IN_DRAFT');
  });

  it('expired-draft-returns-410', async () => {
    await ctx.dataSource
      .getRepository(Video)
      .update({ public_id: videoId }, { upload_expires_at: new Date(0) });

    const res = await getParts(ownerToken).expect(410);

    expect((res.body as PartsBody).error).toBe('UPLOAD_EXPIRED');
  });

  it('list-parts-without-token-returns-401', async () => {
    await getParts().expect(401);
  });
});
