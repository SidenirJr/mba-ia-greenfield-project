import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class InitiateUploadDto {
  /** Original file name chosen by the user. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  file_name: string;

  /** File size in bytes; values above the configured upload limit are rejected with 413. */
  @IsInt()
  @Min(1)
  size_bytes: number;

  /** MIME type of the file; must start with `video/`. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  content_type: string;
}
