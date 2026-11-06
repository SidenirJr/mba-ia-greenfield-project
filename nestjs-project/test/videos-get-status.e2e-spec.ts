import request from 'supertest';
import { Channel } from '../src/channels/entities/channel.entity';
import {
  createVideosE2eApp,
  registerConfirmAndLogin,
  type VideosE2eApp,
} from '../src/test/videos-e2e-app';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/videos.constants';

interface StatusBody {
  id: string;
  status: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  container_format: string | null;
  bitrate_bps: number | null;
  error_code: string | null;
  error_message: string | null;
  error: string;
  message: string;
}

describe('videos-get-status', () => {
  let ctx: VideosE2eApp;
  let ownerToken: string;
  let otherToken: string;

  const getStatus = (id: string, token?: string) => {
    const req = request(ctx.app.getHttpServer()).get(`/videos/${id}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  // Semeia um vídeo sob o canal do dono por insert direto (ready/error só nascem do worker).
  const seedVideo = async (fields: Partial<Video>): Promise<string> => {
    const channel = await ctx.dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user: { email: 'owner@example.com' } });
    const publicId = 'seed0000001';
    await ctx.dataSource.getRepository(Video).save({
      public_id: publicId,
      channel_id: channel.id,
      original_file_name: 'seed.mp4',
      content_type: 'video/mp4',
      size_bytes: 6291456,
      part_size: 5242880,
      part_count: 2,
      ...fields,
    });
    return publicId;
  };

  beforeAll(async () => {
    ctx = await createVideosE2eApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ownerToken = await registerConfirmAndLogin(ctx.app, 'owner@example.com');
    otherToken = await registerConfirmAndLogin(ctx.app, 'other@example.com');
  });

  // 1. GET /videos/:id — status do dono

  it('owner-reads-fresh-draft', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        file_name: 'sample.mp4',
        size_bytes: 6291456,
        content_type: 'video/mp4',
      })
      .expect(201);
    const videoId = (created.body as { id: string }).id;

    const res = await getStatus(videoId, ownerToken).expect(200);

    expect(res.body).toMatchObject({
      id: videoId,
      status: 'draft',
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      container_format: null,
      bitrate_bps: null,
      error_code: null,
      error_message: null,
    });
  });

  it('ready-video-exposes-metadata', async () => {
    const videoId = await seedVideo({
      status: VideoStatus.READY,
      duration_seconds: 12.5,
      width: 1280,
      height: 720,
      video_codec: 'h264',
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitrate_bps: 800000,
    });

    const res = await getStatus(videoId, ownerToken).expect(200);

    expect(res.body).toMatchObject({
      status: 'ready',
      duration_seconds: 12.5,
      width: 1280,
      height: 720,
      video_codec: 'h264',
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitrate_bps: 800000,
    });
  });

  it('error-video-exposes-error-fields', async () => {
    const videoId = await seedVideo({
      status: VideoStatus.ERROR,
      error_code: 'UNREADABLE_MEDIA',
      error_message: 'Could not read the media',
    });

    const res = await getStatus(videoId, ownerToken).expect(200);

    expect(res.body).toMatchObject({
      status: 'error',
      error_code: 'UNREADABLE_MEDIA',
      error_message: 'Could not read the media',
    });
  });

  it('other-user-and-unknown-id-return-same-404', async () => {
    const videoId = await seedVideo({ status: VideoStatus.READY });

    const alien = await getStatus(videoId, otherToken).expect(404);
    const unknown = await getStatus('aaaaaaaaaaa', ownerToken).expect(404);

    expect((alien.body as StatusBody).error).toBe('VIDEO_NOT_FOUND');
    expect(unknown.body).toEqual(alien.body);
  });

  it('get-status-without-token-returns-401', async () => {
    await getStatus('aaaaaaaaaaa').expect(401);
  });

  it('response-never-leaks-upload-id-or-metadata', async () => {
    const videoId = await seedVideo({
      status: VideoStatus.READY,
      upload_id: 'secret-upload-id',
      metadata: { streams: [{ codec_type: 'video' }] },
    });

    const res = await getStatus(videoId, ownerToken).expect(200);

    expect(res.body).not.toHaveProperty('upload_id');
    expect(res.body).not.toHaveProperty('metadata');
  });
});
