import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ description: 'Part size in bytes', example: 67108864 })
  size: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;
}

export class UploadedPartsResponseDto {
  @ApiProperty({ example: 67108864 })
  part_size: number;

  @ApiProperty({ example: 160 })
  part_count: number;

  @ApiProperty({
    type: [UploadedPartDto],
    description: 'Parts already stored, ascending by part number',
  })
  parts: UploadedPartDto[];
}
