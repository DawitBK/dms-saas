import http from 'node:http';
import { attachmentDisposition } from '../src/shared/contentDisposition.js';

describe('attachmentDisposition', () => {
  it('passes a plain ASCII name through', () => {
    expect(attachmentDisposition('plan.pdf')).toBe(`attachment; filename="plan.pdf"; filename*=UTF-8''plan.pdf`);
  });

  it('keeps a non-Latin name usable: ASCII fallback plus RFC 5987 filename*', () => {
    const header = attachmentDisposition('ደብዳቤ 1.pdf');
    expect(header).toContain('filename="____ 1.pdf"'.replace('____', '____'));
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('ደብዳቤ 1.pdf')}`);
    // header must be latin1-safe
    expect([...header].every((c) => c.charCodeAt(0) <= 0x7e)).toBe(true);
  });

  it('neutralises quotes, backslashes and CR/LF', () => {
    const header = attachmentDisposition('a"b\\c\r\nSet-Cookie: x=1.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.split('filename="')[1]!.split('";')[0]).not.toMatch(/["\\]/);
  });

  it('escapes the characters RFC 5987 does not allow in filename*', () => {
    expect(attachmentDisposition("it's (1)*.pdf")).toContain("filename*=UTF-8''it%27s%20%281%29%2A.pdf");
  });

  it('falls back to a default for an empty name', () => {
    expect(attachmentDisposition('')).toContain('filename="document"');
    expect(attachmentDisposition(null)).toContain('filename="document"');
  });

  it('is accepted by Node as a header value for a non-Latin name (the raw name is not)', async () => {
    const send = (value: string) =>
      new Promise<number>((resolve) => {
        const server = http.createServer((_q, r) => {
          try { r.setHeader('Content-Disposition', value); r.end('ok'); } catch { r.statusCode = 500; r.end('x'); }
        }).listen(0, () => {
          http.get({ port: (server.address() as { port: number }).port }, (res) => {
            res.resume();
            res.on('end', () => { server.close(); resolve(res.statusCode ?? 0); });
          });
        });
      });
    expect(await send(`attachment; filename="ደብዳቤ.pdf"`)).toBe(500);
    expect(await send(attachmentDisposition('ደብዳቤ.pdf'))).toBe(200);
  });
});
