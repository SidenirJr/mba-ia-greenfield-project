import {
  classifyToolFailure,
  MediaErrorCode,
  MediaProcessingError,
  sanitizeSignedUrls,
} from './media-processing.error';
import { mapProbeOutput, thumbnailSeekSeconds } from './media-probe.mapper';
import type { FfprobeOutput } from './media.types';

const SIGNED_URL =
  'http://minio:9000/bucket/videos/abc/original?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef';

const probeOutput = (
  overrides: Partial<FfprobeOutput> = {},
): FfprobeOutput => ({
  format: {
    filename: SIGNED_URL,
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '12.512000',
    bit_rate: '800000',
    size: '1250000',
    nb_streams: 2,
    tags: { major_brand: 'isom' },
  },
  streams: [
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100' },
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 640,
      height: 360,
      pix_fmt: 'yuv420p',
      disposition: { default: 1 },
    },
  ],
  ...overrides,
});

describe('mapProbeOutput', () => {
  it('maps the first video stream and the format into normalized fields', () => {
    const result = mapProbeOutput(probeOutput());

    expect(result).toMatchObject({
      durationSeconds: 12.512,
      width: 640,
      height: 360,
      videoCodec: 'h264',
      containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
      bitrateBps: 800000,
    });
  });

  it('keeps a trimmed metadata without format.filename or the signed URL', () => {
    const output = probeOutput();
    output.format!.tags = { comment: SIGNED_URL };

    const { metadata } = mapProbeOutput(output);

    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('X-Amz-Signature');
    expect(serialized).not.toContain('filename');
    expect(metadata).toMatchObject({
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', size: '1250000' },
    });
    expect((metadata.streams as unknown[]).length).toBe(2);
    expect(serialized).not.toContain('disposition');
  });

  it('falls back to the stream duration and a null bitrate when the format lacks them', () => {
    const output = probeOutput();
    delete output.format!.duration;
    delete output.format!.bit_rate;
    output.streams![1].duration = '3.0';

    const result = mapProbeOutput(output);

    expect(result.durationSeconds).toBe(3);
    expect(result.bitrateBps).toBeNull();
  });

  it('fails with a non-retryable NO_VIDEO_STREAM when there is no video stream', () => {
    const output = probeOutput({ streams: [{ codec_type: 'audio' }] });

    expect(() => mapProbeOutput(output)).toThrow(
      expect.objectContaining({
        code: MediaErrorCode.NO_VIDEO_STREAM,
        retryable: false,
      }) as MediaProcessingError,
    );
  });

  it('fails with a non-retryable UNREADABLE_MEDIA when there is no valid duration', () => {
    const output = probeOutput();
    output.format!.duration = 'N/A';

    expect(() => mapProbeOutput(output)).toThrow(
      expect.objectContaining({
        code: MediaErrorCode.UNREADABLE_MEDIA,
        retryable: false,
      }) as MediaProcessingError,
    );
  });
});

describe('thumbnailSeekSeconds', () => {
  it.each([
    [100, 10],
    [5, 1],
    [1, 1],
    [0.5, 0.5],
  ])('for a duration of %p seconds seeks at %p', (duration, expected) => {
    expect(thumbnailSeekSeconds(duration)).toBeCloseTo(expected, 5);
  });
});

describe('classifyToolFailure', () => {
  it.each([
    'Invalid data found when processing input',
    'moov atom not found',
    'Could not find codec parameters for stream 0',
    '[mp3 @ 0x1] Failed to read frame size: Could not seek to 5119.',
    '[mp3 @ 0x1] Invalid frame size (1153): Could not seek to 4284.',
  ])('classifies "%s" as non-retryable with the given content code', (text) => {
    const error = classifyToolFailure(
      { stderr: text, timedOut: false },
      MediaErrorCode.UNREADABLE_MEDIA,
    );

    expect(error).toMatchObject({
      code: MediaErrorCode.UNREADABLE_MEDIA,
      retryable: false,
    });
  });

  it.each([
    'Server returned 503 Service Unavailable',
    'Connection refused',
    'Input/output error',
  ])('classifies "%s" as retryable TRANSIENT', (text) => {
    const error = classifyToolFailure(
      { stderr: text, timedOut: false },
      MediaErrorCode.UNREADABLE_MEDIA,
    );

    expect(error).toMatchObject({
      code: MediaErrorCode.TRANSIENT,
      retryable: true,
    });
  });

  it('classifies a timeout as retryable even when stderr looks like invalid data', () => {
    const error = classifyToolFailure(
      { stderr: 'Invalid data found', timedOut: true },
      MediaErrorCode.UNREADABLE_MEDIA,
    );

    expect(error.retryable).toBe(true);
  });

  it('removes signed URLs from the error message', () => {
    const error = classifyToolFailure(
      { stderr: `${SIGNED_URL}: Invalid data found`, timedOut: false },
      MediaErrorCode.UNREADABLE_MEDIA,
    );

    expect(error.message).not.toContain('X-Amz-Signature');
    expect(error.message).toContain('Invalid data found');
  });
});

describe('sanitizeSignedUrls', () => {
  it('replaces every http(s) URL in the text', () => {
    const text = `a ${SIGNED_URL} b https://x.test/y?z=1`;

    expect(sanitizeSignedUrls(text)).toBe('a [redacted-url] b [redacted-url]');
  });
});
