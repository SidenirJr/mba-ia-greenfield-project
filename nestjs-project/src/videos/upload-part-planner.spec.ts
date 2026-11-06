import { planUploadParts } from './upload-part-planner';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe('planUploadParts', () => {
  it('plans 160 parts of 64 MiB for 10 GiB with the default part size', () => {
    expect(planUploadParts(10 * GiB, 64 * MiB)).toEqual({
      partSize: 64 * MiB,
      partCount: 160,
    });
  });

  it('never goes below the 5 MiB minimum part size', () => {
    expect(planUploadParts(100 * MiB, 1 * MiB)).toEqual({
      partSize: 5 * MiB,
      partCount: 20,
    });
  });

  it('lets ceil(size / 10000) dominate for sizes that would exceed 10000 parts', () => {
    const size = 100 * GiB;

    const { partSize, partCount } = planUploadParts(size, 5 * MiB);

    expect(partSize).toBe(Math.ceil(size / 10000));
    expect(partCount).toBeLessThanOrEqual(10000);
  });

  it('plans a single part for a 1 byte file', () => {
    expect(planUploadParts(1, 64 * MiB)).toEqual({
      partSize: 64 * MiB,
      partCount: 1,
    });
  });

  it('does not add a trailing part when the size is an exact multiple', () => {
    expect(planUploadParts(128 * MiB, 64 * MiB).partCount).toBe(2);
    expect(planUploadParts(128 * MiB + 1, 64 * MiB).partCount).toBe(3);
  });
});
