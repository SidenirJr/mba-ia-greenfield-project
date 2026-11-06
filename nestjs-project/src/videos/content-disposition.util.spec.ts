import { buildAttachmentDisposition } from './content-disposition.util';

describe('buildAttachmentDisposition', () => {
  it('emits attachment with the ascii filename and the UTF-8 filename*', () => {
    expect(buildAttachmentDisposition('clip.mp4')).toBe(
      `attachment; filename="clip.mp4"; filename*=UTF-8''clip.mp4`,
    );
  });

  it('removes quotes, backslashes and slashes from the name', () => {
    const header = buildAttachmentDisposition('a"b\\c/d.mp4');

    expect(header).toBe(
      `attachment; filename="abcd.mp4"; filename*=UTF-8''abcd.mp4`,
    );
  });

  it('never lets CR or LF (header injection) reach the value', () => {
    const header = buildAttachmentDisposition(
      'evil.mp4\r\nSet-Cookie: x=1\u0000\t',
    );

    expect(header).not.toMatch(/\p{Cc}/u);
    expect(header.split('"')).toHaveLength(3);
    expect(header).toContain(`filename="evil.mp4Set-Cookie: x=1"`);
  });

  it('keeps a non-ASCII name in filename* and replaces it in the ascii fallback', () => {
    expect(buildAttachmentDisposition('ação é vídeo.mp4')).toBe(
      `attachment; filename="a__o _ v_deo.mp4"; filename*=UTF-8''a%C3%A7%C3%A3o%20%C3%A9%20v%C3%ADdeo.mp4`,
    );
  });

  it('percent-encodes the RFC 5987 reserved characters in filename*', () => {
    expect(buildAttachmentDisposition("it's (a) *test*.mp4")).toContain(
      `filename*=UTF-8''it%27s%20%28a%29%20%2Atest%2A.mp4`,
    );
  });

  it('falls back to a default name when nothing usable remains, including lone surrogates', () => {
    expect(buildAttachmentDisposition('"\r\n/')).toBe(
      `attachment; filename="video"; filename*=UTF-8''video`,
    );
    expect(() => buildAttachmentDisposition('x\uD800.mp4')).not.toThrow();
  });
});
