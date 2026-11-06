import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidContentTypeException,
  InvalidPartNumberException,
  UploadExpiredException,
  UploadSizeExceedsLimitException,
  VideoNotFoundException,
  VideoNotInDraftException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import { Video } from './entities/video.entity';
import { planUploadParts } from './upload-part-planner';
import { VideoStatus } from './videos.constants';
import { VideosRepository } from './videos.repository';

const VIDEO_CONTENT_TYPE_PREFIX = 'video/';
const MS_PER_HOUR = 3600_000;

@Injectable()
export class VideosService {
  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @Inject(uploadConfig.KEY)
    private readonly config: ConfigType<typeof uploadConfig>,
    @Inject(storageConfig.KEY)
    private readonly storageSettings: ConfigType<typeof storageConfig>,
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

    try {
      const uploadId = await this.storageService.createMultipartUpload(
        videoOriginalKey(draft.id),
        dto.content_type,
      );
      await this.videosRepository.setUploadId(draft.id, uploadId);
    } catch (error) {
      // Compensação: sem multipart aberto o rascunho não serve para nada.
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

  // Ponto único de propriedade/estado/validade; vídeo alheio e inexistente são indistinguíveis (404).
  private async getOwnedDraft(
    userId: string,
    publicId: string,
    options: { requireValid: boolean } = { requireValid: true },
  ): Promise<Video> {
    const channel = await this.channelsService.getByUserId(userId);
    const video = await this.videosRepository.findOwnedByPublicId(
      publicId,
      channel.id,
    );
    if (!video) throw new VideoNotFoundException();
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
}
