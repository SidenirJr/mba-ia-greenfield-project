import { execFile } from 'node:child_process';
import { access, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import {
  cleanupFixtures,
  generateAudioOnlyFile,
  generateCorruptFile,
  generateMultipartVideo,
  generateNonFaststartMp4,
  generateSampleVideo,
} from './video-fixtures';

const run = promisify(execFile);
const MIB = 1024 * 1024;

const probe = (path: string) =>
  run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'csv=p=0',
    path,
  ]).then((out) => out.stdout.trim().split('\n').filter(Boolean));

// Percorre os átomos de topo do MP4 (size + type) e devolve a ordem em que aparecem.
async function topLevelAtoms(path: string): Promise<string[]> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const atoms: string[] = [];
    const header = Buffer.alloc(8);
    for (let offset = 0; offset < size; ) {
      await file.read(header, 0, 8, offset);
      const boxSize = header.readUInt32BE(0);
      atoms.push(header.toString('latin1', 4, 8));
      if (boxSize === 0) break; // vai até o fim do arquivo
      if (boxSize === 1) {
        const extended = Buffer.alloc(8);
        await file.read(extended, 0, 8, offset + 8);
        offset += Number(extended.readBigUInt64BE(0));
      } else {
        offset += boxSize;
      }
    }
    return atoms;
  } finally {
    await file.close();
  }
}

describe('video-fixtures (ffmpeg/ffprobe reais)', () => {
  const generated: string[] = [];

  afterAll(async () => {
    await cleanupFixtures();
    for (const path of generated) {
      await expect(access(dirname(path))).rejects.toThrow();
    }
  });

  it('generates a faststart sample with a video stream, moov before mdat', async () => {
    const path = await generateSampleVideo();
    generated.push(path);

    expect(await probe(path)).toContain('video');
    const atoms = await topLevelAtoms(path);
    expect(atoms.indexOf('moov')).toBeLessThan(atoms.indexOf('mdat'));
  });

  it('generates a multipart video of at least 6 MiB readable by ffprobe', async () => {
    const path = await generateMultipartVideo();
    generated.push(path);

    // Entre 6 e 10 MiB: com partes de 5 MiB dá exatamente 2 partes.
    const { size } = await stat(path);
    expect(size).toBeGreaterThanOrEqual(6 * MIB);
    expect(size).toBeLessThanOrEqual(10 * MIB);
    expect(await probe(path)).toContain('video');
  });

  it('generates an mp4 whose moov atom comes after mdat', async () => {
    const path = await generateNonFaststartMp4();
    generated.push(path);

    const atoms = await topLevelAtoms(path);
    expect(atoms.indexOf('moov')).toBeGreaterThan(atoms.indexOf('mdat'));
  });

  it('generates a corrupt file that ffprobe cannot read', async () => {
    const path = await generateCorruptFile();
    generated.push(path);

    await expect(probe(path)).rejects.toMatchObject({
      code: expect.any(Number) as number,
    });
  });

  it('generates an audio-only file with no video stream', async () => {
    const path = await generateAudioOnlyFile();
    generated.push(path);

    const streams = await probe(path);
    expect(streams).toContain('audio');
    expect(streams).not.toContain('video');
  });
});
