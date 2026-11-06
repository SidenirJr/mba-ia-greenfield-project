import { Module } from '@nestjs/common';
import { MediaToolsService } from './media-tools.service';

@Module({
  providers: [MediaToolsService],
  exports: [MediaToolsService],
})
export class MediaModule {}
