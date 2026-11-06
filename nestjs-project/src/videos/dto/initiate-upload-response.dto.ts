import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../videos.constants';

export class InitiateUploadResponseDto {
  @ApiProperty({
    description: 'Public id of the video',
    example: 'dQw4w9WgXcQ',
  })
  id: string;

  @ApiProperty({ enum: Object.values(VideoStatus), example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({
    description:
      'Part size in bytes; the client must slice the file with this size (the last part may be smaller)',
    example: 67108864,
  })
  part_size: number;

  @ApiProperty({ example: 160 })
  part_count: number;

  @ApiProperty({
    description: 'Upload deadline (ISO 8601)',
    example: '2026-11-06T12:00:00.000Z',
  })
  expires_at: string;
}
