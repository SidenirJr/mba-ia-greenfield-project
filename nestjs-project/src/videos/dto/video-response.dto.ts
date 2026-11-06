import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../videos.constants';

export class VideoResponseDto {
  @ApiProperty({
    description: 'Public id of the video',
    example: 'dQw4w9WgXcQ',
  })
  id: string;

  @ApiProperty({
    enum: Object.values(VideoStatus),
    example: VideoStatus.PROCESSING,
  })
  status: VideoStatus;

  @ApiProperty({ example: 'holidays.mp4' })
  original_file_name: string;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty({ description: 'Declared size in bytes', example: 6291456 })
  size_bytes: number;

  @ApiProperty({ type: Number, nullable: true, example: 12.5 })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1280 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 720 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'mov,mp4,m4a,3gp,3g2,mj2',
  })
  container_format: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 800000 })
  bitrate_bps: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'UNREADABLE_MEDIA' })
  error_code: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  error_message: string | null;

  @ApiProperty({ example: '2026-11-06T12:00:00.000Z' })
  created_at: string;

  @ApiProperty({ example: '2026-11-06T12:05:00.000Z' })
  updated_at: string;
}
