import { generateVideoPublicId } from './video-public-id.util';

describe('generateVideoPublicId', () => {
  it('should return 11 characters from the base62 alphabet', () => {
    expect(generateVideoPublicId()).toMatch(/^[0-9A-Za-z]{11}$/);
  });

  it('should never emit "-" or "_" nor characters outside the alphabet over many samples', () => {
    const joined = Array.from({ length: 2000 }, generateVideoPublicId).join('');

    expect(joined).toMatch(/^[0-9A-Za-z]+$/);
  });

  it('should use the whole alphabet (digits, upper and lower case)', () => {
    const joined = Array.from({ length: 2000 }, generateVideoPublicId).join('');

    expect(joined).toMatch(/[0-9]/);
    expect(joined).toMatch(/[A-Z]/);
    expect(joined).toMatch(/[a-z]/);
  });

  it('should produce distinct values across calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, generateVideoPublicId));

    expect(ids.size).toBe(1000);
  });
});
