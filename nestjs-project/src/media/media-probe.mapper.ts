import {
  MediaErrorCode,
  MediaProcessingError,
  sanitizeSignedUrls,
} from './media-processing.error';
import type {
  FfprobeOutput,
  FfprobeStream,
  MediaProbeResult,
} from './media.types';

const FORMAT_KEYS = [
  'format_name',
  'format_long_name',
  'nb_streams',
  'start_time',
  'duration',
  'size',
  'bit_rate',
  'probe_score',
  'tags',
];
const STREAM_KEYS = [
  'index',
  'codec_type',
  'codec_name',
  'codec_long_name',
  'profile',
  'width',
  'height',
  'pix_fmt',
  'r_frame_rate',
  'avg_frame_rate',
  'duration',
  'bit_rate',
  'sample_rate',
  'channels',
  'tags',
];
const DURATION_DECIMALS = 3;
const MIN_THUMBNAIL_SEEK_SECONDS = 1;
const THUMBNAIL_SEEK_FRACTION = 0.1;

const pick = (
  source: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> =>
  Object.fromEntries(
    keys.filter((k) => k in source).map((k) => [k, source[k]]),
  );

const toPositiveNumber = (value: unknown): number | null => {
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Instante do frame da thumbnail: 10% da duração, no mínimo 1s e no máximo a própria duração (TD-14).
export function thumbnailSeekSeconds(durationSeconds: number): number {
  return Math.min(
    Math.max(
      durationSeconds * THUMBNAIL_SEEK_FRACTION,
      MIN_THUMBNAIL_SEEK_SECONDS,
    ),
    durationSeconds,
  );
}

export function mapProbeOutput(output: FfprobeOutput): MediaProbeResult {
  const format = output.format ?? {};
  const streams = output.streams ?? [];
  const video: FfprobeStream | undefined = streams.find(
    (s) => s.codec_type === 'video',
  );
  if (!video) {
    throw new MediaProcessingError(
      MediaErrorCode.NO_VIDEO_STREAM,
      'Media has no video stream',
      false,
    );
  }
  const duration = toPositiveNumber(format.duration ?? video.duration);
  if (duration === null) {
    throw new MediaProcessingError(
      MediaErrorCode.UNREADABLE_MEDIA,
      'Media has no valid duration',
      false,
    );
  }
  const bitrate = toPositiveNumber(format.bit_rate ?? video.bit_rate);

  // `format.filename` (a URL assinada) nunca entra no metadata; a varredura final cobre tags que a repitam.
  const metadata = JSON.parse(
    sanitizeSignedUrls(
      JSON.stringify({
        format: pick(format, FORMAT_KEYS),
        streams: streams.map((s) => pick(s, STREAM_KEYS)),
      }),
    ),
  ) as Record<string, unknown>;

  return {
    durationSeconds: Number(duration.toFixed(DURATION_DECIMALS)),
    width: video.width ?? null,
    height: video.height ?? null,
    videoCodec: video.codec_name ?? null,
    containerFormat: format.format_name ?? null,
    bitrateBps: bitrate === null ? null : Math.round(bitrate),
    metadata,
  };
}
