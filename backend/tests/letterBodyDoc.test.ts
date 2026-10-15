import { extractPlainText, letterBodyDocSchema, parseLetterBody } from '../src/modules/letters/letterBodyDoc.js';

describe('structured letter body compatibility', () => {
  it('accepts pasted heading and code-block nodes and preserves their text', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Copied heading' }] },
        { type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text: 'copied\ncontent' }] },
      ],
    };
    expect(letterBodyDocSchema.safeParse(doc).success).toBe(true);
    expect(extractPlainText(parseLetterBody(JSON.stringify(doc)))).toContain('Copied heading');
    expect(extractPlainText(parseLetterBody(JSON.stringify(doc)))).toContain('copied\ncontent');
  });
});
