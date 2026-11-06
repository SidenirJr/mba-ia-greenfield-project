import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { MAX_PARTS } from '../videos.constants';

export class PartUrlsDto {
  /** Part numbers (1-based) to sign; duplicates are collapsed and each must not exceed the part count. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_PARTS)
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
