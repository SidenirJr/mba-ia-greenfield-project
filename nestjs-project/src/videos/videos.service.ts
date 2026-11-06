import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidContentTypeException,
  UploadSizeExceedsLimitException,
} from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';
import { videoOriginalKey } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { planUploadParts } from './upload-part-planner';
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
}
