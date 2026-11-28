// @vitest-environment jsdom

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChatView, renderPlan } from '../public/js/ui.js';

const PLAN = {
  intent: 'change',
  now_iso: '2026-11-28T12:00:00.000Z',
  temporal_refs: [],
  memory: { window: null, keywords: ['crm'] },
  search_plan: [{ query: 'ToolA pricing', mode: 'quick' }],
  verify_snapshot_ids: [],
};

const GROUPS = [
  {
    query: 'ToolA pricing',
    results: [
      { url: 'https://one.example.com/a', title: 'One', snippet: 'raw snippet one' },
      { url: 'https://two.example.com/b', title: 'Two', snippet: 'raw snippet two' },
    ],
  },
  {
    query: 'bad result',
    results: [
      { url: 'javascript:alert(1)', title: 'Bad', snippet: 'raw snippet bad' },
      { url: 'https://three.example.com/c', title: 'Three', snippet: 'raw snippet three' },
    ],
  },
];

beforeAll(() => {
  // jsdom does not implement scrolling.
  window.scrollTo = () => {};
  Element.prototype.scrollTo = () => {};
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = (callback) => {
      callback(0);
      return 0;
    };
  }
});

afterAll(() => {
  document.body.replaceChildren();
});

beforeEach(() => {
  document.body.replaceChildren();
});

function makeView() {
  const chat = document.createElement('div');
  chat.id = 'chat';

  const messagesEl = document.createElement('div');
  const emptyEl = document.createElement('div');
  const modeEl = document.createElement('span');
  const sessionEl = document.createElement('span');
  document.body.append(chat, messagesEl, emptyEl, modeEl, sessionEl);

  return {
    view: new ChatView({ messagesEl, emptyEl, modeEl, sessionEl }),
    messagesEl,
  };
}

describe('plan card', () => {
  it('is a collapsed details element labelled as the thought process', () => {
    const bubble = document.createElement('div');
    renderPlan(bubble, PLAN);

    const details = bubble.querySelector<HTMLDetailsElement>(
      'details.plan-card',
    );
    if (!details) throw new Error('expected a plan details element');

    expect(details.open).toBe(false);
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain(
      'View thought process',
    );
  });
});

describe('assistant answer', () => {
  it('renders inline citation links and a sources footer, not raw results', () => {
    const { view, messagesEl } = makeView();
    const message = view.addMessage('assistant', '');

    message.setSources(GROUPS);
    message.appendToken(
      'TypeScript is typed [1], and Neon is [2]. An unknown source [3].',
    );
    message.complete();

    // Raw search results are never put in the chat flow.
    expect(messagesEl.querySelector('.results-card')).toBeNull();
    expect(messagesEl.textContent).not.toContain('Web Results');
    expect(messagesEl.textContent).not.toContain('raw snippet');

    const citations = messagesEl.querySelectorAll('a.citation');
    expect(citations).toHaveLength(2);
    expect(citations[0]?.textContent).toBe('[1]');
    expect(citations[0]?.getAttribute('href')).toBe('https://one.example.com/a');
    expect(citations[0]?.getAttribute('target')).toBe('_blank');
    expect(citations[0]?.getAttribute('rel')).toBe('noopener noreferrer');

    // Index 3 is a javascript: URL, so it is dropped and stays plain text.
    expect(messagesEl.textContent).toContain('[3]');
    expect(messagesEl.querySelector('a[href^="javascript:"]')).toBeNull();

    const footer = messagesEl.querySelector('.answer-sources');
    if (!footer) throw new Error('expected a sources footer');

    expect(footer.textContent).toContain('Sources');
    expect(footer.textContent).toContain('One');
    expect(footer.textContent).toContain('Two');
    expect(footer.textContent).not.toContain('Bad');

    const footerLinks = footer.querySelectorAll('a');
    expect(footerLinks).toHaveLength(2);
    expect(footerLinks[0]?.getAttribute('href')).toBe('https://one.example.com/a');
  });

  it('omits the sources footer when the answer cites nothing', () => {
    const { view, messagesEl } = makeView();
    const message = view.addMessage('assistant', '');

    message.setSources(GROUPS);
    message.appendToken('No citations in this answer.');
    message.complete();

    expect(messagesEl.querySelector('.answer-sources')).toBeNull();
  });
});
