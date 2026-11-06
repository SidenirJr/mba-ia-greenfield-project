import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Vídeos de exemplo gerados em tempo de teste com ffmpeg lavfi (TD-12): nada binário é versionado.
const createdDirs: string[] = [];

export interface SampleVideoOptions {
  durationSeconds?: number;
  // `false` deixa o átomo moov no fim do arquivo (padrão do muxer mp4), como câmeras e gravadores.
  faststart?: boolean;
  // Tamanho mínimo do arquivo: usa conteúdo com ruído (incompressível) e alonga a duração até atingir.
  minBytes?: number;
}

// shortcut: estimativa empírica de ~3 MB/s para 640x360 com ruído em libx264 crf 23; recalibrar se mudar o filtro.
const NOISY_BYTES_PER_SECOND = 3_000_000;
const MAX_ATTEMPTS = 4;

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-fixture-'));
  createdDirs.push(dir);
  return dir;
}

async function encode(
  path: string,
  durationSeconds: number,
  faststart: boolean,
  noisy: boolean,
): Promise<void> {
  const size = noisy ? '640x360' : '320x240';
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=25:duration=${durationSeconds}`,
    ...(noisy ? ['-vf', 'noise=alls=40:allf=t'] : []),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    ...(faststart ? ['-movflags', '+faststart'] : []),
    path,
  ]);
}

// Devolve o caminho do MP4 gerado (H.264, sem áudio).
export async function generateSampleVideo(
  options: SampleVideoOptions = {},
): Promise<string> {
  const { faststart = true, minBytes } = options;
  const path = join(await fixtureDir(), 'sample.mp4');
  if (minBytes === undefined) {
    await encode(path, options.durationSeconds ?? 1, faststart, false);
    return path;
  }

  let duration = Math.max(
    options.durationSeconds ?? 0,
    (minBytes * 1.15) / NOISY_BYTES_PER_SECOND,
  );
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await encode(path, duration, faststart, true);
    if ((await stat(path)).size >= minBytes) return path;
    duration *= 1.5;
  }
  throw new Error(`Could not generate a fixture of at least ${minBytes} bytes`);
}

// ≥ 6 MiB: exercita o upload em 2 partes de 5 MiB (a última pode ser menor).
export function generateMultipartVideo(): Promise<string> {
  return generateSampleVideo({ minBytes: 6 * 1024 * 1024 });
}

export function generateNonFaststartMp4(): Promise<string> {
  return generateSampleVideo({ faststart: false });
}

// Bytes aleatórios com extensão de vídeo: o ffprobe não reconhece o formato.
export async function generateCorruptFile(): Promise<string> {
  const path = join(await fixtureDir(), 'corrupt.mp4');
  await writeFile(path, randomBytes(4096));
  return path;
}

// MP4 válido com apenas uma faixa de áudio (AAC): sem stream de vídeo.
export async function generateAudioOnlyFile(): Promise<string> {
  const path = join(await fixtureDir(), 'audio-only.mp4');
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:a',
    'aac',
    path,
  ]);
  return path;
}

export async function cleanupFixtures(): Promise<void> {
  await Promise.all(
    createdDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
}
