import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, QueryFailedError, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Video } from './entities/video.entity';
import { generateVideoPublicId } from './video-public-id.util';
import { VideoStatus } from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';
const MAX_RETRIES = 5;

export interface CreateDraftData {
  channel_id: string;
  original_file_name: string;
  content_type: string;
  size_bytes: number;
  part_size: number;
  part_count: number;
  upload_expires_at: Date;
}

export type ReadyFields = Pick<
  Video,
  | 'duration_seconds'
  | 'width'
  | 'height'
  | 'video_codec'
  | 'container_format'
  | 'bitrate_bps'
  | 'metadata'
>;

function isPublicIdCollision(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as QueryFailedError & { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(PUBLIC_ID_COLUMN)
  );
}

@Injectable()
export class VideosRepository {
  constructor(
    @InjectRepository(Video) private readonly repository: Repository<Video>,
  ) {}

  async createDraft(data: CreateDraftData): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.repository.save(
          this.repository.create({
            ...data,
            public_id: generateVideoPublicId(),
          }),
        );
      } catch (err) {
        // Colisão do public_id: gera outro; esgotadas as tentativas, propaga o erro original.
        if (!isPublicIdCollision(err) || attempt >= MAX_RETRIES) throw err;
      }
    }
  }

  findByPublicId(publicId: string): Promise<Video | null> {
    return this.repository.findOneBy({ public_id: publicId });
  }

  findOwnedByPublicId(
    publicId: string,
    channelId: string,
  ): Promise<Video | null> {
    return this.repository.findOneBy({
      public_id: publicId,
      channel_id: channelId,
    });
  }

  findById(id: string): Promise<Video | null> {
    return this.repository.findOneBy({ id });
  }

  async setUploadId(id: string, uploadId: string): Promise<void> {
    await this.repository.update({ id }, { upload_id: uploadId });
  }

  async deleteDraft(id: string): Promise<number> {
    const result = await this.repository.delete({
      id,
      status: VideoStatus.DRAFT,
    });
    return result.affected ?? 0;
  }

  transitionToProcessing(id: string, now: Date): Promise<number> {
    return this.guardedUpdate(id, VideoStatus.DRAFT, {
      status: VideoStatus.PROCESSING,
      upload_id: null,
      upload_expires_at: null,
      processing_started_at: now,
    });
  }

  markReady(id: string, fields: ReadyFields): Promise<number> {
    return this.guardedUpdate(id, VideoStatus.PROCESSING, {
      ...fields,
      status: VideoStatus.READY,
      error_code: null,
      error_message: null,
      // O tipo QueryDeepPartialEntity do TypeORM não aceita objetos em colunas jsonb.
    } as QueryDeepPartialEntity<Video>);
  }

  markError(id: string, code: string, message: string): Promise<number> {
    return this.guardedUpdate(id, VideoStatus.PROCESSING, {
      status: VideoStatus.ERROR,
      error_code: code,
      error_message: message,
    });
  }

  markDraftError(id: string, code: string, message: string): Promise<number> {
    return this.guardedUpdate(id, VideoStatus.DRAFT, {
      status: VideoStatus.ERROR,
      error_code: code,
      error_message: message,
    });
  }

  findExpiredDrafts(now: Date, limit: number): Promise<Video[]> {
    return this.repository.find({
      where: { status: VideoStatus.DRAFT, upload_expires_at: LessThan(now) },
      order: { upload_expires_at: 'ASC' },
      take: limit,
    });
  }

  findStaleProcessing(olderThan: Date, limit: number): Promise<Video[]> {
    return this.repository.find({
      where: {
        status: VideoStatus.PROCESSING,
        processing_started_at: LessThan(olderThan),
      },
      order: { processing_started_at: 'ASC' },
      take: limit,
    });
  }

  // UPDATE ... WHERE status = <from>: `affected` 0 significa que outro ator já fez a transição (idempotência).
  private async guardedUpdate(
    id: string,
    from: VideoStatus,
    set: QueryDeepPartialEntity<Video>,
  ): Promise<number> {
    const result = await this.repository
      .createQueryBuilder()
      .update(Video)
      .set(set)
      .where('id = :id AND status = :from', { id, from })
      .execute();
    return result.affected ?? 0;
  }
}
