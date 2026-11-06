import { randomInt } from 'node:crypto';
import { VIDEO_PUBLIC_ID_LENGTH } from './videos.constants';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// randomInt(62) por caractere evita o viés de módulo; sem `-`/`_` para o id ser seguro em URL e seleção de texto.
export function generateVideoPublicId(): string {
  let id = '';
  for (let i = 0; i < VIDEO_PUBLIC_ID_LENGTH; i++) {
    id += ALPHABET[randomInt(ALPHABET.length)];
  }
  return id;
}
