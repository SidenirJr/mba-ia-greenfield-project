import request from 'supertest';
import {
  createVideosE2eApp,
  registerConfirmAndLogin,
  type VideosE2eApp,
} from '../src/test/videos-e2e-app';
import { videoOriginalKey } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/videos.constants';

interface ErrorBody {
  error: string;
}

describe('videos-abort-upload', () => {
  let ctx: VideosE2eApp;
  let ownerToken: string;
  let otherToken: string;
  let videoId: string;

  const abort = (token?: string) => {
    const req = request(ctx.app.getHttpServer()).delete(
      `/videos/${videoId}/upload`,
    );
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  const findVideo = () =>
    ctx.dataSource.getRepository(Video).findOneBy({ public_id: videoId });

  beforeAll(async () => {
    ctx = await createVideosE2eApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  // Cada cenário parte de um rascunho do dono criado por POST /videos.
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

  // 1. DELETE /videos/:id/upload — abortar

  it('owner-aborts-draft-returns-204', async () => {
    const draft = await findVideo();
    const storage = ctx.moduleRef.get(StorageService);
    const key = videoOriginalKey(draft!.id);

    const res = await abort(ownerToken).expect(204);

    expect(res.body).toEqual({});
    expect(await findVideo()).toBeNull();
    await expect(
      storage.listParts(key, draft!.upload_id!),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });
  });

  it('other-user-gets-404-and-draft-remains', async () => {
    const res = await abort(otherToken).expect(404);

    expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    expect((await findVideo())?.upload_id).toEqual(expect.any(String));
  });

  it('processing-video-returns-409', async () => {
    await ctx.dataSource
      .getRepository(Video)
      .update({ public_id: videoId }, { status: VideoStatus.PROCESSING });

    const res = await abort(ownerToken).expect(409);

    expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_IN_DRAFT');
    expect(await findVideo()).not.toBeNull();
  });

  it('abort-without-token-returns-401', async () => {
    await abort().expect(401);
  });
});
