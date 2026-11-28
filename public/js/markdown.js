/**
 * A deliberately small, safe markdown renderer.
 *
 * The model's answer is untrusted text, so nothing here uses innerHTML: every
 * node is built explicitly and links are restricted to http(s). The parsers are
 * pure functions, unit-tested in Node; only renderMarkdown touches the DOM.
 */

import { safeUrl } from './url.js';

const INLINE = /(\[[^\]]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[(\d+)\])/g;

export function tokenizeInline(text) {
  const tokens = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ type: 'text', text: text.slice(cursor, index) });
    }

    const raw = match[0];
    const citation = /^\[(\d+)\]$/.exec(raw);

    if (citation) {
      tokens.push({ type: 'cite', index: Number(citation[1]) });
    } else if (raw.startsWith('**')) {
      tokens.push({ type: 'strong', text: raw.slice(2, -2) });
    } else if (raw.startsWith('`')) {
      tokens.push({ type: 'code', text: raw.slice(1, -1) });
    } else if (raw.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(raw);
      tokens.push(
        link
          ? { type: 'link', text: link[1], href: link[2] }
          : { type: 'text', text: raw },
      );
    } else {
      tokens.push({ type: 'em', text: raw.slice(1, -1) });
    }

    cursor = index + raw.length;
  }

  if (cursor < text.length) {
    tokens.push({ type: 'text', text: text.slice(cursor) });
  }

  return tokens;
}

const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+\.\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;

export function parseBlocks(text) {
  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'p', lines: paragraph });
      paragraph = [];
    }
  };

  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: 'h',
        level: heading[1].length,
        text: heading[2],
      });
      continue;
    }

    const bullet = BULLET.exec(trimmed);
    if (bullet) {
      flushParagraph();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }

    const numbered = NUMBERED.exec(trimmed);
    if (numbered) {
      flushParagraph();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(numbered[1]);
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function appendInline(parent, text, sources) {
  for (const token of tokenizeInline(text)) {
    if (token.type === 'text') {
      parent.append(document.createTextNode(token.text));
      continue;
    }

    if (token.type === 'cite') {
      const source = sources.get(token.index);
      if (!source) {
        parent.append(document.createTextNode(`[${token.index}]`));
        continue;
      }
      const citation = document.createElement('a');
      citation.className = 'citation';
      citation.href = source.url;
      citation.target = '_blank';
      citation.rel = 'noopener noreferrer';
      citation.textContent = `[${token.index}]`;
      parent.append(citation);
      continue;
    }

    if (token.type === 'link') {
      const href = safeUrl(token.href);
      if (!href) {
        parent.append(document.createTextNode(token.text));
        continue;
      }
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = token.text;
      parent.append(anchor);
      continue;
    }

    const tag = token.type === 'strong' ? 'strong' : token.type === 'em' ? 'em' : 'code';
    const node = document.createElement(tag);
    node.textContent = token.text;
    parent.append(node);
  }
}

/** Render markdown into a DocumentFragment (never innerHTML). */
export function renderMarkdown(text, sources = new Map()) {
  const fragment = document.createDocumentFragment();

  for (const block of parseBlocks(text)) {
    if (block.type === 'p') {
      const p = document.createElement('p');
      block.lines.forEach((line, index) => {
        if (index > 0) p.append(document.createElement('br'));
        appendInline(p, line, sources);
      });
      fragment.append(p);
      continue;
    }

    if (block.type === 'h') {
      const heading = document.createElement(
        block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5',
      );
      appendInline(heading, block.text, sources);
      fragment.append(heading);
      continue;
    }

    const list = document.createElement(block.type);
    for (const item of block.items) {
      const li = document.createElement('li');
      appendInline(li, item, sources);
      list.append(li);
    }
    fragment.append(list);
  }

  return fragment;
}
