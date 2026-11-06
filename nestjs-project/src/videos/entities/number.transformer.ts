import type { ValueTransformer } from 'typeorm';

// pg devolve bigint/numeric como string; os valores deste domínio (≤ 10 GiB, duração, bitrate) cabem em number.
export const numberTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};
