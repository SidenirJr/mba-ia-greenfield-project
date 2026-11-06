import { execFile } from 'node:child_process';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import workerConfig from '../config/worker.config';
import {
  classifyToolFailure,
  MediaErrorCode,
  MediaProcessingError,
} from './media-processing.error';
import { mapProbeOutput, thumbnailSeekSeconds } from './media-probe.mapper';
import type { FfprobeOutput, MediaProbeResult } from './media.types';

const MAX_PROBE_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 32 * 1024 * 1024;
const THUMBNAIL_MAX_WIDTH = 1280;
const THUMBNAIL_JPEG_QUALITY = '3';

interface ToolResult {
  stdout: Buffer;
}

@Injectable()
export class MediaToolsService {
  constructor(
    @Inject(workerConfig.KEY)
    private readonly config: ConfigType<typeof workerConfig>,
  ) {}

  async probe(inputUrl: string): Promise<MediaProbeResult> {
    const { stdout } = await this.run(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        inputUrl,
      ],
      MediaErrorCode.UNREADABLE_MEDIA,
      MAX_PROBE_OUTPUT_BYTES,
    );
    let output: FfprobeOutput;
    try {
      output = JSON.parse(stdout.toString('utf8')) as FfprobeOutput;
    } catch {
      throw new MediaProcessingError(
        MediaErrorCode.UNREADABLE_MEDIA,
        'ffprobe returned an unparseable result',
        false,
      );
    }
    return mapProbeOutput(output);
  }

  async extractThumbnail(
    inputUrl: string,
    durationSeconds: number,
  ): Promise<Buffer> {
    const seek = thumbnailSeekSeconds(durationSeconds);
    let jpeg = await this.grabFrame(inputUrl, seek);
    // Um seek no fim exato da mídia (vídeos de ~1 frame) não decodifica nada: tenta o primeiro frame.
    if (jpeg.length === 0 && seek > 0) jpeg = await this.grabFrame(inputUrl, 0);
    if (jpeg.length === 0) {
      throw new MediaProcessingError(
        MediaErrorCode.THUMBNAIL_FAILED,
        'ffmpeg produced no frame',
        false,
      );
    }
    return jpeg;
  }

  private async grabFrame(inputUrl: string, seek: number): Promise<Buffer> {
    // -ss antes de -i: seek rápido por Range HTTP em vez de decodificar desde o início (TD-14).
    const { stdout } = await this.run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(seek),
        '-i',
        inputUrl,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
        '-q:v',
        THUMBNAIL_JPEG_QUALITY,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      MediaErrorCode.THUMBNAIL_FAILED,
      MAX_THUMBNAIL_BYTES,
    );
    return stdout;
  }

  private run(
    command: string,
    args: string[],
    contentErrorCode: MediaErrorCode,
    maxBuffer: number,
  ): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          encoding: 'buffer',
          timeout: this.config.ffmpegTimeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer,
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ stdout });
          const timedOut = (error as { killed?: boolean }).killed === true;
          // O erro cru do execFile traz a linha de comando (com a URL assinada): só o stderr sanitizado sai daqui.
          reject(
            classifyToolFailure(
              {
                stderr:
                  stderr.toString('utf8') ||
                  `exit ${String((error as NodeJS.ErrnoException).code)}`,
                timedOut,
              },
              contentErrorCode,
            ),
          );
        },
      );
    });
  }
}
