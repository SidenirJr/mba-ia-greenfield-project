import request from 'supertest';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/videos.constants';
import storageConfig from '../src/config/storage.config';
import {
  createVideosE2eApp,
  registerConfirmAndLogin,
  type VideosE2eApp,
} from '../src/test/videos-e2e-app';

interface PartUrlsBody {
  parts: { part_number: number; url: string }[];
  expires_in: number;
  error: string;
}

describe('videos-part-urls', () => {
  let ctx: VideosE2eApp;
  let ownerToken: string;
  let otherToken: string;
  let videoId: string;

  const postPartUrls = (body: object, token?: string, id = videoId) => {
    const req = request(ctx.app.getHttpServer()).post(
      `/videos/${id}/upload/part-urls`,
    );
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
      body,
    );
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

  // 1. POST /videos/:id/upload/part-urls — URLs por parte

  it('owner-gets-presigned-urls', async () => {
    const res = await postPartUrls({ part_numbers: [1, 2] }, ownerToken).expect(
      200,
    );

    const body = res.body as PartUrlsBody;
    expect(body.parts.map((p) => p.part_number)).toEqual([1, 2]);
    const publicHost = new URL(storageConfig().publicEndpoint).host;
    for (const part of body.parts) {
      expect(new URL(part.url).host).toBe(publicHost);
    }
    expect(body.expires_in).toBe(storageConfig().presignExpiresSeconds);
  });

  it('other-user-gets-404', async () => {
    const res = await postPartUrls({ part_numbers: [1] }, otherToken).expect(
      404,
    );

    expect((res.body as PartUrlsBody).error).toBe('VIDEO_NOT_FOUND');
  });

  it('part-number-out-of-range-returns-400', async () => {
    const outOfRange = await postPartUrls(
      { part_numbers: [3] },
      ownerToken,
    ).expect(400);
    expect((outOfRange.body as PartUrlsBody).error).toBe('INVALID_PART_NUMBER');

    const empty = await postPartUrls({ part_numbers: [] }, ownerToken).expect(
      400,
    );
    expect((empty.body as PartUrlsBody).error).toBe('VALIDATION_ERROR');
  });

  it('video-not-in-draft-returns-409', async () => {
    await ctx.dataSource
      .getRepository(Video)
      .update({ public_id: videoId }, { status: VideoStatus.PROCESSING });

    const res = await postPartUrls({ part_numbers: [1] }, ownerToken).expect(
      409,
    );

    expect((res.body as PartUrlsBody).error).toBe('VIDEO_NOT_IN_DRAFT');
  });

  it('expired-draft-returns-410', async () => {
    await ctx.dataSource
      .getRepository(Video)
      .update({ public_id: videoId }, { upload_expires_at: new Date(0) });

    const res = await postPartUrls({ part_numbers: [1] }, ownerToken).expect(
      410,
    );

    expect((res.body as PartUrlsBody).error).toBe('UPLOAD_EXPIRED');
  });

  it('part-urls-without-token-returns-401', async () => {
    await postPartUrls({ part_numbers: [1] }).expect(401);
  });
});
