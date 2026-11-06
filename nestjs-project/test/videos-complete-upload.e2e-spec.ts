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

interface CompleteBody {
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
}

interface UploadedPart {
  part_number: number;
  etag: string;
}

const FILE_BYTES = 6291456; // 2 partes: 5 MiB + 1 MiB

describe('videos-complete-upload', () => {
  let ctx: VideosE2eApp;
  let ownerToken: string;
  let otherToken: string;

  const post = (path: string, token?: string) => {
    const req = request(ctx.app.getHttpServer()).post(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  const initiate = async (sizeBytes = FILE_BYTES): Promise<string> => {
    const res = await post('/videos', ownerToken)
      .send({
        file_name: 'sample.mp4',
        size_bytes: sizeBytes,
        content_type: 'video/mp4',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  // Obtém as URLs por parte e faz o PUT real no storage, devolvendo os ETags.
  const uploadAllParts = async (
    videoId: string,
    fileBytes = FILE_BYTES,
  ): Promise<UploadedPart[]> => {
    const urls = await post(`/videos/${videoId}/upload/part-urls`, ownerToken)
      .send({ part_numbers: [1, 2] })
      .expect(200);
    const parts = (
      urls.body as { parts: { part_number: number; url: string }[] }
    ).parts;
    const uploaded: UploadedPart[] = [];
    for (const { part_number, url } of parts) {
      const size =
        part_number === 1
          ? E2E_PART_SIZE_BYTES
          : fileBytes - E2E_PART_SIZE_BYTES;
      const put = await requestPresignedUrl(url, {
        method: 'PUT',
        body: Buffer.alloc(size, part_number),
      });
      expect(put.status).toBe(200);
      uploaded.push({ part_number, etag: put.headers.etag as string });
    }
    return uploaded;
  };

  const findVideo = (publicId: string) =>
    ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });

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

  // 1. POST /videos/:id/upload/complete — finalização

  it('complete-moves-video-to-processing', async () => {
    const videoId = await initiate();
    const parts = await uploadAllParts(videoId);

    const res = await post(`/videos/${videoId}/upload/complete`, ownerToken)
      .send({ parts })
      .expect(202);

    const body = res.body as CompleteBody;
    expect(body).toMatchObject({
      id: videoId,
      status: 'processing',
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      container_format: null,
      bitrate_bps: null,
      error_code: null,
      error_message: null,
    });
    const video = await findVideo(videoId);
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.upload_id).toBeNull();
    expect(
      await ctx.processingQueue.getJob(`process-video-${video.id}`),
    ).toBeDefined();
  });

  it('repeated-complete-returns-409', async () => {
    const videoId = await initiate();
    const parts = await uploadAllParts(videoId);
    await post(`/videos/${videoId}/upload/complete`, ownerToken)
      .send({ parts })
      .expect(202);

    const res = await post(`/videos/${videoId}/upload/complete`, ownerToken)
      .send({ parts })
      .expect(409);

    expect((res.body as CompleteBody).error).toBe('VIDEO_NOT_IN_DRAFT');
    const video = await findVideo(videoId);
    const jobs = await ctx.processingQueue.getJobs([
      'waiting',
      'delayed',
      'active',
    ]);
    expect(jobs.map((job) => job.id)).toEqual([`process-video-${video.id}`]);
  });

  it('wrong-etag-returns-400-invalid-parts', async () => {
    const videoId = await initiate();
    const parts = await uploadAllParts(videoId);
    parts[0].etag = '"00000000000000000000000000000000"';

    const res = await post(`/videos/${videoId}/upload/complete`, ownerToken)
      .send({ parts })
      .expect(400);

    expect((res.body as CompleteBody).error).toBe('INVALID_UPLOAD_PARTS');
  });

  it('empty-parts-returns-400-validation', async () => {
    const videoId = await initiate();

    const res = await post(`/videos/${videoId}/upload/complete`, ownerToken)
      .send({ parts: [] })
      .expect(400);

    expect((res.body as CompleteBody).error).toBe('VALIDATION_ERROR');
  });

  it('size-mismatch-returns-409-and-marks-error', async () => {
    const videoId = await initiate();
    // Declara 6 MiB (2 partes) mas envia 1 KiB a menos na última parte.
    const parts = await uploadAllParts(videoId, FILE_BYTES - 1024);

    const res = await post(`/videos/${videoId}/upload/complete`, ownerToken)
      .send({ parts })
      .expect(409);

    expect((res.body as CompleteBody).error).toBe('UPLOAD_SIZE_MISMATCH');
    const video = await findVideo(videoId);
    expect(video.status).toBe(VideoStatus.ERROR);
    expect(video.error_code).toBe('UPLOAD_SIZE_MISMATCH');
  });

  it('other-user-gets-404', async () => {
    const videoId = await initiate();
    const parts = await uploadAllParts(videoId);

    const res = await post(`/videos/${videoId}/upload/complete`, otherToken)
      .send({ parts })
      .expect(404);

    expect((res.body as CompleteBody).error).toBe('VIDEO_NOT_FOUND');
  });

  it('expired-draft-returns-410', async () => {
    const videoId = await initiate();
    const parts = await uploadAllParts(videoId);
    await ctx.dataSource
      .getRepository(Video)
      .update({ public_id: videoId }, { upload_expires_at: new Date(0) });

    const res = await post(`/videos/${videoId}/upload/complete`, ownerToken)
      .send({ parts })
      .expect(410);

    expect((res.body as CompleteBody).error).toBe('UPLOAD_EXPIRED');
  });

  it('complete-without-token-returns-401', async () => {
    const videoId = await initiate();

    await post(`/videos/${videoId}/upload/complete`)
      .send({ parts: [{ part_number: 1, etag: '"x"' }] })
      .expect(401);
  });
});
