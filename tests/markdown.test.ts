import { describe, expect, it } from 'vitest';
import { parseBlocks, tokenizeInline } from '../public/js/markdown.js';
import { prettyUrl, safeUrl } from '../public/js/url.js';

describe('tokenizeInline', () => {
  it('keeps plain text as one token', () => {
    expect(tokenizeInline('hello world')).toEqual([
      { type: 'text', text: 'hello world' },
    ]);
  });

  it('parses bold, italic, code and links', () => {
    const tokens = tokenizeInline(
      'a **bold** and *em* and `code` and [docs](https://example.com/x).',
    );

    expect(tokens).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'strong', text: 'bold' },
      { type: 'text', text: ' and ' },
      { type: 'em', text: 'em' },
      { type: 'text', text: ' and ' },
      { type: 'code', text: 'code' },
      { type: 'text', text: ' and ' },
      { type: 'link', text: 'docs', href: 'https://example.com/x' },
      { type: 'text', text: '.' },
    ]);
  });

  it('leaves unmatched markup alone', () => {
    expect(tokenizeInline('a * b')).toEqual([{ type: 'text', text: 'a * b' }]);
    expect(tokenizeInline('**unclosed')).toEqual([
      { type: 'text', text: '**unclosed' },
    ]);
  });
});

describe('parseBlocks', () => {
  it('splits paragraphs on blank lines', () => {
    expect(parseBlocks('one\ntwo\n\nthree')).toEqual([
      { type: 'p', lines: ['one', 'two'] },
      { type: 'p', lines: ['three'] },
    ]);
  });

  it('parses unordered and ordered lists', () => {
    expect(parseBlocks('- a\n- b\n\n1. one\n2. two')).toEqual([
      { type: 'ul', items: ['a', 'b'] },
      { type: 'ol', items: ['one', 'two'] },
    ]);
  });

  it('parses headings and switches lists', () => {
    expect(parseBlocks('## Pricing\n\n- a\n\n1. b')).toEqual([
      { type: 'h', level: 2, text: 'Pricing' },
      { type: 'ul', items: ['a'] },
      { type: 'ol', items: ['b'] },
    ]);
  });

  it('keeps prose around a list as its own paragraph', () => {
    expect(parseBlocks('Intro\n- a\nOutro')).toEqual([
      { type: 'p', lines: ['Intro'] },
      { type: 'ul', items: ['a'] },
      { type: 'p', lines: ['Outro'] },
    ]);
  });
});

describe('url helpers', () => {
  it('allows only http(s)', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('http://example.com')).toBe('http://example.com/');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,x')).toBeNull();
    expect(safeUrl('/relative')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
  });

  it('pretty-prints a host and path', () => {
    expect(prettyUrl('https://www.example.com/a/b/')).toBe('example.com/a/b');
    expect(prettyUrl('https://example.com/')).toBe('example.com');
  });
});
