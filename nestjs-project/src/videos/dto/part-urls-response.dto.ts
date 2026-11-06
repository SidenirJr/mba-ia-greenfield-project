import { ApiProperty } from '@nestjs/swagger';

export class PartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    description:
      'Presigned URL for the public storage endpoint; PUT the raw part bytes and keep the response ETag header',
    example: 'http://localhost:9000/streamtube/videos/uuid/original?X-Amz-...',
  })
  url: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [PartUrlDto] })
  parts: PartUrlDto[];

  @ApiProperty({
    description: 'Seconds until the URLs expire',
    example: 900,
  })
  expires_in: number;
}
