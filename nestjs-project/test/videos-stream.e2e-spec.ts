import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { Channel } from '../src/channels/entities/channel.entity';
import { videoOriginalKey } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { requestPresignedUrl } from '../src/test/storage-test';
import {
  createVideosE2eApp,
  registerConfirmAndLogin,
  type VideosE2eApp,
} from '../src/test/videos-e2e-app';
import {
  cleanupFixtures,
  generateSampleVideo,
} from '../src/test/video-fixtures';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/videos.constants';

describe('videos-stream', () => {
  let ctx: VideosE2eApp;
  let sampleVideo: Buffer;
  let counter = 0;

  const stream = (id: string) =>
    request(ctx.app.getHttpServer()).get(`/videos/${id}/stream`).redirects(0);

  // Semeia um vídeo sob o canal do dono por insert direto (ready/processing/error só nascem do worker).
  const seedVideo = async (status: VideoStatus): Promise<Video> => {
    const channel = await ctx.dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user: { email: 'owner@example.com' } });
    const video = await ctx.dataSource.getRepository(Video).save({
      public_id: `stream${String(++counter).padStart(5, '0')}`,
      channel_id: channel.id,
      original_file_name: 'seed.mp4',
      content_type: 'video/mp4',
      size_bytes: sampleVideo.length,
      part_size: 5242880,
      part_count: 1,
      status,
    });
    if (status === VideoStatus.READY) {
      await ctx.moduleRef
        .get(StorageService)
        .putObject(videoOriginalKey(video.id), sampleVideo, 'video/mp4');
    }
    return video;
  };

  beforeAll(async () => {
    ctx = await createVideosE2eApp();
    sampleVideo = await readFile(await generateSampleVideo());
  });

  afterAll(async () => {
    await cleanupFixtures();
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    await registerConfirmAndLogin(ctx.app, 'owner@example.com');
  });

  // 1. GET /videos/:id/stream — streaming público

  it('anonymous-stream-redirects-to-public-storage-host', async () => {
    const video = await seedVideo(VideoStatus.READY);

    const res = await stream(video.public_id).expect(302);

    const location = new URL(res.headers.location);
    expect(location.host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT as string).host,
    );
    expect(location.pathname).toContain(videoOriginalKey(video.id));
  });

  it('location-with-range-returns-206', async () => {
    const video = await seedVideo(VideoStatus.READY);
    const res = await stream(video.public_id).expect(302);

    const ranged = await requestPresignedUrl(res.headers.location, {
      range: 'bytes=0-99',
    });

    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toMatch(/^bytes 0-99\//);
    expect(ranged.headers['accept-ranges']).toBeDefined();
    expect(ranged.headers['content-type']).toBe('video/mp4');
  });

  it('non-ready-or-unknown-video-returns-404', async () => {
    for (const status of [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.ERROR,
    ]) {
      const video = await seedVideo(status);

      const res = await stream(video.public_id).expect(404);

      expect(res.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    }

    const unknown = await stream('aaaaaaaaaaa').expect(404);

    expect(unknown.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
  });
});
