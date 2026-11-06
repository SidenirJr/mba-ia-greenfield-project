import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PartUrlsResponseDto } from './dto/part-urls-response.dto';
import { PartUrlsDto } from './dto/part-urls.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Pre-registers the video as a draft under the caller's channel, opens the multipart upload in the object storage and returns the part plan the client must follow.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Authenticated user has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Declared size exceeds the allowed upload limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Content type is not a video type',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Issue presigned URLs for upload parts',
    description:
      'Issues (or re-issues) presigned UploadPart URLs for the requested part numbers of a draft owned by the caller. The client PUTs the raw part bytes and keeps the response ETag header.',
  })
  @ApiParam({ name: 'id', description: 'Public id of the video' })
  @ApiResponse({
    status: 200,
    description: 'Presigned URLs for the requested parts',
    type: PartUrlsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number out of range',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 410,
    description: 'Upload has expired',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: PartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return this.videosService.getPartUrls(user.sub, id, dto.part_numbers);
  }
}
