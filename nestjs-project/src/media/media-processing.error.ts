export const MediaErrorCode = {
  UNREADABLE_MEDIA: 'UNREADABLE_MEDIA',
  NO_VIDEO_STREAM: 'NO_VIDEO_STREAM',
  THUMBNAIL_FAILED: 'THUMBNAIL_FAILED',
  TRANSIENT: 'TRANSIENT',
} as const;

export type MediaErrorCode =
  (typeof MediaErrorCode)[keyof typeof MediaErrorCode];

const MAX_MESSAGE_LENGTH = 500;
// Dados que o ffmpeg/ffprobe rejeitam por conteúdo (não adianta tentar de novo).
const INVALID_DATA_PATTERN =
  /invalid data found|moov atom not found|could not find codec parameters|invalid frame size|failed to read frame size|header missing|unknown format|unsupported|not implemented|no such codec/i;
const URL_PATTERN = /https?:\/\/[^\s'"]+/gi;

export class MediaProcessingError extends Error {
  constructor(
    public readonly code: MediaErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

// URLs pré-assinadas carregam a assinatura na query: nunca podem chegar a logs, erros ou banco (TD-06).
export function sanitizeSignedUrls(text: string): string {
  return text.replace(URL_PATTERN, '[redacted-url]');
}

export interface ToolFailure {
  stderr: string;
  timedOut: boolean;
}

// shortcut: classifica por regex no stderr do ffmpeg 5.x; o que não casa vira TRANSIENT (retry limitado a 3 tentativas), revisar se surgirem falsos positivos.
export function classifyToolFailure(
  failure: ToolFailure,
  contentErrorCode: MediaErrorCode,
): MediaProcessingError {
  const detail = sanitizeSignedUrls(failure.stderr.trim()).slice(
    -MAX_MESSAGE_LENGTH,
  );
  if (!failure.timedOut && INVALID_DATA_PATTERN.test(detail)) {
    return new MediaProcessingError(
      contentErrorCode,
      `Media could not be read: ${detail}`,
      false,
    );
  }
  const reason = failure.timedOut ? 'timed out' : 'failed';
  return new MediaProcessingError(
    MediaErrorCode.TRANSIENT,
    `Media tool ${reason}: ${detail}`.trim(),
    true,
  );
}
