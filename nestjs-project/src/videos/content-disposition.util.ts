const FALLBACK_FILE_NAME = 'video';

// RFC 5987 attr-char exclui ' ( ) *, que encodeURIComponent deixa passar.
const percentEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

// Segurança de header (TD-08): o nome vem do cliente, então CR/LF, controles, aspas e barras nunca chegam ao valor.
export function buildAttachmentDisposition(fileName: string): string {
  const clean =
    fileName.replace(/[\p{Cc}\p{Cs}"\\/]/gu, '').trim() || FALLBACK_FILE_NAME;
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${percentEncode(clean)}`;
}
