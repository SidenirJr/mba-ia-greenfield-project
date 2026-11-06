import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import * as publicIdUtil from './video-public-id.util';
import { VideoStatus } from './videos.constants';
import { VideosModule } from './videos.module';
import { CreateDraftData, VideosRepository } from './videos.repository';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const READY_FIELDS = {
  duration_seconds: 12.5,
  width: 640,
  height: 360,
  video_codec: 'h264',
  container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
  bitrate_bps: 800000,
  metadata: { format: {}, streams: [] },
};

describe('VideosRepository (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let repository: VideosRepository;
  let channel: Channel;
  let otherChannel: Channel;
  let counter = 0;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    dataSource = moduleRef.get(DataSource);
    repository = moduleRef.get(VideosRepository);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanAllTables(dataSource);
    const createChannel = async () => {
      const user = await dataSource.getRepository(User).save({
        email: `repo_user_${++counter}@example.com`,
        password: 'hashed',
      });
      return dataSource.getRepository(Channel).save({
        name: 'Chan',
        nickname: `repochan${counter}`,
        user_id: user.id,
      });
    };
    channel = await createChannel();
    otherChannel = await createChannel();
  });

  const draftData = (
    overrides: Partial<CreateDraftData> = {},
  ): CreateDraftData => ({
    channel_id: channel.id,
    original_file_name: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 1024,
    part_size: 67108864,
    part_count: 1,
    upload_expires_at: new Date(Date.now() + 3600_000),
    ...overrides,
  });

  const processingVideo = async () => {
    const video = await repository.createDraft(draftData());
    await repository.transitionToProcessing(video.id, new Date());
    return video;
  };

  describe('createDraft', () => {
    it('should persist a draft with an 11-character alphanumeric public_id', async () => {
      const video = await repository.createDraft(draftData());

      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.public_id).toMatch(/^[0-9A-Za-z]{11}$/);
      expect((await repository.findById(video.id))?.public_id).toBe(
        video.public_id,
      );
    });

    it('should regenerate the public_id when the first one already exists', async () => {
      await repository.createDraft(draftData());
      const [existing] = await dataSource.getRepository(Video).find();
      const spy = jest
        .spyOn(publicIdUtil, 'generateVideoPublicId')
        .mockReturnValueOnce(existing.public_id)
        .mockReturnValueOnce('FreshPubl01');

      const video = await repository.createDraft(draftData());

      expect(spy).toHaveBeenCalledTimes(2);
      expect(video.public_id).toBe('FreshPubl01');
    });

    it('should propagate the error after 5 consecutive collisions', async () => {
      await repository.createDraft(draftData());
      const [existing] = await dataSource.getRepository(Video).find();
      const spy = jest
        .spyOn(publicIdUtil, 'generateVideoPublicId')
        .mockReturnValue(existing.public_id);

      const err = await repository
        .createDraft(draftData())
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(QueryFailedError);
      expect((err as { code?: string }).code).toBe('23505');
      expect(spy).toHaveBeenCalledTimes(5);
    });
  });

  describe('lookups and simple writes', () => {
    it('should find by public id with or without the owner channel', async () => {
      const video = await repository.createDraft(draftData());

      expect((await repository.findByPublicId(video.public_id))?.id).toBe(
        video.id,
      );
      expect(
        (await repository.findOwnedByPublicId(video.public_id, channel.id))?.id,
      ).toBe(video.id);
      expect(
        await repository.findOwnedByPublicId(video.public_id, otherChannel.id),
      ).toBeNull();
      expect(await repository.findByPublicId('NoSuchPubId')).toBeNull();
    });

    it('should set the upload id', async () => {
      const video = await repository.createDraft(draftData());

      await repository.setUploadId(video.id, 'upload-123');

      expect((await repository.findById(video.id))?.upload_id).toBe(
        'upload-123',
      );
    });

    it('should delete only drafts', async () => {
      const draft = await repository.createDraft(draftData());
      const processing = await processingVideo();

      expect(await repository.deleteDraft(processing.id)).toBe(0);
      expect(await repository.deleteDraft(draft.id)).toBe(1);

      expect(await repository.findById(processing.id)).not.toBeNull();
      expect(await repository.findById(draft.id)).toBeNull();
    });
  });

  describe('guarded transitions', () => {
    it('should move draft to processing only once, clearing upload fields', async () => {
      const video = await repository.createDraft(draftData());
      await repository.setUploadId(video.id, 'upload-1');
      const now = new Date();

      expect(await repository.transitionToProcessing(video.id, now)).toBe(1);
      expect(await repository.transitionToProcessing(video.id, now)).toBe(0);

      const found = await repository.findById(video.id);
      expect(found).toMatchObject({
        status: VideoStatus.PROCESSING,
        upload_id: null,
        upload_expires_at: null,
      });
      expect(found?.processing_started_at?.getTime()).toBe(now.getTime());
    });

    it('should mark ready only from processing and clear error fields', async () => {
      const draft = await repository.createDraft(draftData());
      expect(await repository.markReady(draft.id, READY_FIELDS)).toBe(0);

      const video = await processingVideo();
      expect(await repository.markReady(video.id, READY_FIELDS)).toBe(1);
      expect(await repository.markReady(video.id, READY_FIELDS)).toBe(0);

      expect(await repository.findById(video.id)).toMatchObject({
        status: VideoStatus.READY,
        ...READY_FIELDS,
        error_code: null,
        error_message: null,
      });
    });

    it('should mark error only from processing and never touch a ready video', async () => {
      const video = await processingVideo();
      const ready = await processingVideo();
      await repository.markReady(ready.id, READY_FIELDS);

      expect(await repository.markError(ready.id, 'X', 'boom')).toBe(0);
      expect(
        await repository.markError(video.id, 'UNREADABLE_MEDIA', 'bad'),
      ).toBe(1);

      expect((await repository.findById(ready.id))?.status).toBe(
        VideoStatus.READY,
      );
      expect(await repository.findById(video.id)).toMatchObject({
        status: VideoStatus.ERROR,
        error_code: 'UNREADABLE_MEDIA',
        error_message: 'bad',
      });
    });

    it('should mark a draft as error only from draft', async () => {
      const draft = await repository.createDraft(draftData());
      const processing = await processingVideo();

      expect(await repository.markDraftError(processing.id, 'C', 'm')).toBe(0);
      expect(
        await repository.markDraftError(draft.id, 'UPLOAD_SIZE_MISMATCH', 'm'),
      ).toBe(1);
      expect(
        await repository.markDraftError(draft.id, 'UPLOAD_SIZE_MISMATCH', 'm'),
      ).toBe(0);

      expect(await repository.findById(draft.id)).toMatchObject({
        status: VideoStatus.ERROR,
        error_code: 'UPLOAD_SIZE_MISMATCH',
      });
    });
  });

  describe('sweeper queries', () => {
    it('should return only drafts with an expired upload deadline, oldest first, respecting the limit', async () => {
      const now = new Date();
      const older = await repository.createDraft(
        draftData({ upload_expires_at: new Date(now.getTime() - 7200_000) }),
      );
      const recent = await repository.createDraft(
        draftData({ upload_expires_at: new Date(now.getTime() - 60_000) }),
      );
      await repository.createDraft(
        draftData({ upload_expires_at: new Date(now.getTime() + 3600_000) }),
      );
      const expiredButProcessing = await repository.createDraft(
        draftData({ upload_expires_at: new Date(now.getTime() - 60_000) }),
      );
      await repository.transitionToProcessing(expiredButProcessing.id, now);

      const expired = await repository.findExpiredDrafts(now, 10);
      const limited = await repository.findExpiredDrafts(now, 1);

      expect(expired.map((v) => v.id)).toEqual([older.id, recent.id]);
      expect(limited.map((v) => v.id)).toEqual([older.id]);
    });

    it('should return only processing videos started before the threshold', async () => {
      const now = new Date();
      const stale = await repository.createDraft(draftData());
      await repository.transitionToProcessing(
        stale.id,
        new Date(now.getTime() - 7200_000),
      );
      const fresh = await repository.createDraft(draftData());
      await repository.transitionToProcessing(fresh.id, now);
      await repository.createDraft(draftData());

      const result = await repository.findStaleProcessing(
        new Date(now.getTime() - 3600_000),
        10,
      );

      expect(result.map((v) => v.id)).toEqual([stale.id]);
    });
  });
});
