import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../videos.constants';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `video_user_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Chan',
      nickname: `chan${counter}`,
      user_id: user.id,
    });
  });

  const newVideo = (overrides: Partial<Video> = {}) =>
    videoRepository.create({
      public_id: `pub${++counter}`.padEnd(11, 'x'),
      channel_id: channel.id,
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 10737418240,
      part_size: 67108864,
      part_count: 160,
      ...overrides,
    });

  const pgCode = async (promise: Promise<unknown>) => {
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryFailedError);
    return (err as QueryFailedError & { code?: string }).code;
  };

  it('should default status to draft and leave processing metadata null', async () => {
    const saved = await videoRepository.save(newVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found).toMatchObject({
      upload_id: null,
      upload_expires_at: null,
      processing_started_at: null,
      duration_seconds: null,
      width: null,
      height: null,
      video_codec: null,
      container_format: null,
      bitrate_bps: null,
      metadata: null,
      error_code: null,
      error_message: null,
    });
  });

  it('should reject two videos with the same public_id (23505)', async () => {
    await videoRepository.save(newVideo({ public_id: 'samePublic1' }));

    const code = await pgCode(
      videoRepository.save(newVideo({ public_id: 'samePublic1' })),
    );

    expect(code).toBe('23505');
  });

  it('should reject a video whose channel_id does not exist (23503)', async () => {
    const code = await pgCode(
      videoRepository.save(
        newVideo({ channel_id: '00000000-0000-4000-8000-000000000000' }),
      ),
    );

    expect(code).toBe('23503');
  });

  it('should reject a status outside the enum (22P02)', async () => {
    const code = await pgCode(
      videoRepository.save(newVideo({ status: 'bogus' as VideoStatus })),
    );

    expect(code).toBe('22P02');
  });

  it('should round-trip bigint and numeric columns as numbers', async () => {
    const saved = await videoRepository.save(
      newVideo({ duration_seconds: 12.345, bitrate_bps: 4_500_000 }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(10737418240);
    expect(found.part_size).toBe(67108864);
    expect(found.duration_seconds).toBe(12.345);
    expect(found.bitrate_bps).toBe(4_500_000);
  });

  it('should persist jsonb metadata and load videos through the channel relation', async () => {
    await videoRepository.save(newVideo({ metadata: { format: { a: 1 } } }));

    const loaded = await dataSource
      .getRepository(Channel)
      .findOneOrFail({ where: { id: channel.id }, relations: ['videos'] });

    expect(loaded.videos).toHaveLength(1);
    expect(loaded.videos[0].metadata).toEqual({ format: { a: 1 } });
  });

  it('should let cleanAllTables remove videos without violating the channels FK', async () => {
    await videoRepository.save(newVideo());

    await cleanAllTables(dataSource);

    expect(await videoRepository.count()).toBe(0);
  });
});
