import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidContentTypeException,
  InvalidPartNumberException,
  InvalidUploadPartsException,
  UploadExpiredException,
  UploadSizeExceedsLimitException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { VideoJobsProducer } from '../queue/video-jobs.producer';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { Video } from './entities/video.entity';
import { planUploadParts } from './upload-part-planner';
import { VideoStatus } from './videos.constants';
import { VideosRepository } from './videos.repository';

const VIDEO_CONTENT_TYPE_PREFIX = 'video/';
const MS_PER_HOUR = 3600_000;
const UPLOAD_SIZE_MISMATCH_CODE = 'UPLOAD_SIZE_MISMATCH';
// Erros do S3 que significam "a lista de partes não fecha o objeto".
const INVALID_PARTS_S3_ERRORS = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
]);

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @Inject(uploadConfig.KEY)
    private readonly config: ConfigType<typeof uploadConfig>,
    @Inject(storageConfig.KEY)
    private readonly storageSettings: ConfigType<typeof storageConfig>,
    private readonly videoJobsProducer: VideoJobsProducer,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    if (!dto.content_type.startsWith(VIDEO_CONTENT_TYPE_PREFIX)) {
      throw new InvalidContentTypeException();
    }
    if (dto.size_bytes > this.config.maxBytes) {
      throw new UploadSizeExceedsLimitException();
    }

    const channel = await this.channelsService.getByUserId(userId);
    const { partSize, partCount } = planUploadParts(
      dto.size_bytes,
      this.config.partSizeBytes,
    );
    const uploadExpiresAt = new Date(
      Date.now() + this.config.expirationHours * MS_PER_HOUR,
    );

    const draft = await this.videosRepository.createDraft({
      channel_id: channel.id,
      original_file_name: dto.file_name,
      content_type: dto.content_type,
      size_bytes: dto.size_bytes,
      part_size: partSize,
      part_count: partCount,
      upload_expires_at: uploadExpiresAt,
    });

    let uploadId: string | undefined;
    try {
      uploadId = await this.storageService.createMultipartUpload(
        videoOriginalKey(draft.id),
        dto.content_type,
      );
      await this.videosRepository.setUploadId(draft.id, uploadId);
    } catch (error) {
      // Compensação: sem multipart registrado o rascunho não serve para nada.
      if (uploadId) await this.abortQuietly(draft.id, uploadId);
      await this.videosRepository.deleteDraft(draft.id);
      throw error;
    }

    return {
      id: draft.public_id,
      status: draft.status,
      part_size: partSize,
      part_count: partCount,
      expires_at: uploadExpiresAt.toISOString(),
    };
  }

  async getPartUrls(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<PartUrlsResponseDto> {
    const video = await this.getOwnedDraft(userId, publicId);
    const unique = [...new Set(partNumbers)].sort((a, b) => a - b);
    if (unique.some((partNumber) => partNumber > video.part_count)) {
      throw new InvalidPartNumberException();
    }

    const key = videoOriginalKey(video.id);
    const parts = await Promise.all(
      unique.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          key,
          video.upload_id!,
          partNumber,
        ),
      })),
    );
    return { parts, expires_in: this.storageSettings.presignExpiresSeconds };
  }

  async listUploadedParts(
    userId: string,
    publicId: string,
  ): Promise<UploadedPartsResponseDto> {
    const video = await this.getOwnedDraft(userId, publicId);
    const stored = await this.storageService.listParts(
      videoOriginalKey(video.id),
      video.upload_id!,
    );
    return {
      part_size: video.part_size,
      part_count: video.part_count,
      parts: stored
        .map((part) => ({
          part_number: part.partNumber,
          size: part.size,
          etag: part.etag,
        }))
        .sort((a, b) => a.part_number - b.part_number),
    };
  }

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    const video = await this.getOwnedDraft(userId, publicId);
    const key = videoOriginalKey(video.id);

    try {
      await this.storageService.completeMultipartUpload(
        key,
        video.upload_id!,
        dto.parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch (error) {
      if (
        INVALID_PARTS_S3_ERRORS.has((error as { name?: string }).name ?? '')
      ) {
        throw new InvalidUploadPartsException();
      }
      throw error;
    }

    const { contentLength } = await this.storageService.headObject(key);
    if (contentLength !== video.size_bytes) {
      await this.videosRepository.markDraftError(
        video.id,
        UPLOAD_SIZE_MISMATCH_CODE,
        'Uploaded size does not match the declared size',
      );
      throw new UploadSizeMismatchException();
    }

    const affected = await this.videosRepository.transitionToProcessing(
      video.id,
      new Date(),
    );
    if (affected === 0) throw new VideoNotInDraftException();

    try {
      await this.videoJobsProducer.enqueueProcessing(video.id);
    } catch (error) {
      // Conversão intencional em resultado de domínio: `processing` é durável e o sweeper reenfileira.
      this.logger.error(
        `Failed to enqueue processing for video ${video.id}; the sweeper will retry`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    const processing = await this.videosRepository.findById(video.id);
    if (!processing) throw new VideoNotFoundException();
    return this.toVideoResponse(processing);
  }

  async abortUpload(userId: string, publicId: string): Promise<void> {
    const video = await this.getOwnedDraft(userId, publicId, {
      requireValid: false,
    });
    await this.storageService.abortMultipartUpload(
      videoOriginalKey(video.id),
      video.upload_id!,
    );
    const deleted = await this.videosRepository.deleteDraft(video.id);
    // 0 linhas: um `complete` concorrente já tirou o vídeo de draft.
    if (deleted === 0) throw new VideoNotInDraftException();
  }

  async getOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<VideoResponseDto> {
    return this.toVideoResponse(await this.findOwned(userId, publicId));
  }

  private toVideoResponse(video: Video): VideoResponseDto {
    return {
      id: video.public_id,
      status: video.status,
      original_file_name: video.original_file_name,
      content_type: video.content_type,
      size_bytes: video.size_bytes,
      duration_seconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      video_codec: video.video_codec,
      container_format: video.container_format,
      bitrate_bps: video.bitrate_bps,
      error_code: video.error_code,
      error_message: video.error_message,
      created_at: video.created_at.toISOString(),
      updated_at: video.updated_at.toISOString(),
    };
  }

  // Melhor esforço: um multipart órfão não deve mascarar o erro original da compensação.
  private async abortQuietly(videoId: string, uploadId: string): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(
        videoOriginalKey(videoId),
        uploadId,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to abort multipart upload of video ${videoId}: ${String(error)}`,
      );
    }
  }

  // Ponto único de estado/validade do rascunho do dono.
  private async getOwnedDraft(
    userId: string,
    publicId: string,
    options: { requireValid: boolean } = { requireValid: true },
  ): Promise<Video> {
    const video = await this.findOwned(userId, publicId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotInDraftException();
    }
    if (
      options.requireValid &&
      (!video.upload_expires_at ||
        video.upload_expires_at.getTime() <= Date.now())
    ) {
      throw new UploadExpiredException();
    }
    return video;
  }

  // Vídeo alheio e inexistente são indistinguíveis (404, TD-11).
  private async findOwned(userId: string, publicId: string): Promise<Video> {
    const channel = await this.channelsService.getByUserId(userId);
    const video = await this.videosRepository.findOwnedByPublicId(
      publicId,
      channel.id,
    );
    if (!video) throw new VideoNotFoundException();
    return video;
  }
}
