export interface MediaProbeResult {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  containerFormat: string | null;
  bitrateBps: number | null;
  metadata: Record<string, unknown>;
}

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  bit_rate?: string;
  [key: string]: unknown;
}

export interface FfprobeFormat {
  filename?: string;
  format_name?: string;
  duration?: string;
  bit_rate?: string;
  [key: string]: unknown;
}

export interface FfprobeOutput {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}
