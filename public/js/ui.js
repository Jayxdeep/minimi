/**
 * Presentation layer. Owns every DOM node the chat needs and no transport
 * logic: given an event, update a bubble.
 */

import { renderMarkdown } from './markdown.js';
import { prettyUrl, safeUrl } from './url.js';

/**
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 */
function element(tag, className, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function shortStamp(iso) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso || ''));
  return match ? `${match[1]} ${match[2]}` : String(iso || '—');
}

function chip(text, isEmpty = false) {
  const node = element('span', `plan-chip ${isEmpty ? 'empty-chip' : ''}`.trim(), text);
  return node;
}

function section(label, chips) {
  const wrap = element('div', 'plan-section');
  const head = element('div', 'plan-sec-title', label);
  const line = element('div', 'chip-group');
  line.append(...(chips.length > 0 ? chips : [chip('none', true)]));
  wrap.append(head, line);
  return wrap;
}

/** Render the planner output as a clean structured card plus raw JSON on demand. */
export function renderPlan(bubble, plan) {
  const details = document.createElement('details');
  details.className = 'plan-card';
  details.open = true;

  const summary = document.createElement('summary');
  
  const left = element('div', 'plan-header-left');
  const caret = element('span', 'plan-caret', '▸');
  const title = element('span', 'plan-title', 'Execution Plan');
  
  const intentStr = String(plan.intent || 'unknown').toLowerCase();
  const intentBadge = element('span', `intent-badge intent-${intentStr}`, intentStr);

  left.append(caret, title, intentBadge);
  summary.append(left);

  const body = element('div', 'plan-content');

  // Time expressions
  const refs = (plan.temporal_refs || []).map((ref) =>
    chip(`${ref.expression} → ${shortStamp(ref.resolved_range[0])}`),
  );
  body.append(section('temporal references', refs));

  // Memory window
  const memoryWindow = plan.memory && plan.memory.window;
  body.append(
    section(
      'indexed memory window',
      memoryWindow
        ? [chip(`${shortStamp(memoryWindow[0])} → ${shortStamp(memoryWindow[1])}`)]
        : [],
    ),
  );

  // Recall keywords
  body.append(
    section(
      'recall keywords',
      ((plan.memory && plan.memory.keywords) || []).map((k) => chip(k)),
    ),
  );

  // Snapshot re-verifications
  body.append(
    section(
      're-verify claims',
      (plan.verify_snapshot_ids || []).map((id) =>
        chip(`snapshot #${String(id).slice(0, 8)}`),
      ),
    ),
  );

  // Search queries
  const searchWrap = element('div', 'plan-section');
  const searchHead = element('div', 'plan-sec-title', 'search queries');
  const list = element('ol', 'search-queries-list');
  const queries = plan.search_plan || [];

  if (queries.length === 0) {
    const item = element('li', 'search-query-item');
    item.textContent = 'no live search needed';
    item.style.color = 'var(--text-faint)';
    list.append(item);
  } else {
    for (const query of queries) {
      const item = element('li', 'search-query-item');
      const textSpan = element('span', 'query-text', query.query);
      item.append(textSpan);
      
      const metaSpan = element(
        'cite',
        'query-meta',
        query.mode + (query.since ? ` · since ${query.since}` : ''),
      );
      item.append(metaSpan);
      list.append(item);
    }
  }

  searchWrap.append(searchHead, list);
  body.append(searchWrap);

  // Raw JSON inspect
  const rawWrap = element('details', 'plan-raw-details');
  const rawSummary = element('summary', '', 'Inspect raw planner JSON');
  const raw = element('pre', '', JSON.stringify(plan, null, 2));
  rawWrap.append(rawSummary, raw);

  details.append(summary, body, rawWrap);
  bubble.append(details);
}

/** Render grouped search results as a collapsible "Web Results" card. */
export function renderSearchResults(bubble, groups) {
  const total = groups.reduce((count, group) => count + group.results.length, 0);

  const details = document.createElement('details');
  details.className = 'results-card';
  details.open = true;

  const summary = document.createElement('summary');
  const left = element('div', 'plan-header-left');
  left.append(
    element('span', 'plan-caret', '▸'),
    element('span', 'plan-title', 'Web Results'),
    element(
      'span',
      'results-count',
      `${total} ${total === 1 ? 'source' : 'sources'}`,
    ),
  );
  summary.append(left);

  const content = element('div', 'results-content');
  let sourceIndex = 0;

  if (groups.length === 0) {
    content.append(element('p', 'results-empty', 'No queries were run.'));
  }

  for (const group of groups) {
    const section = element('div', 'results-group');

    const head = element('div', 'results-query');
    head.append(
      element('span', 'query-text', group.query),
      element('span', 'query-count', String(group.results.length)),
    );

    const list = element('ul', 'results-list');

    if (group.results.length === 0) {
      list.append(element('li', 'results-empty', 'No results for this query.'));
    } else {
      for (const result of group.results) {
        const item = element('li', 'result-item');
        const href = safeUrl(result.url);
        const label = result.title || href || 'Untitled result';
        sourceIndex += 1;

        const head = element('div', 'result-head');
        head.append(element('span', 'result-index', `[${sourceIndex}]`));

        if (href) {
          const link = element('a', 'result-title', label);
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          head.append(link);
        } else {
          head.append(element('span', 'result-title', label));
        }

        item.append(head);

        if (href) {
          item.append(element('div', 'result-url', prettyUrl(href)));
        }

        if (result.snippet) {
          item.append(element('p', 'result-snippet', result.snippet));
        }

        list.append(item);
      }
    }

    section.append(head, list);
    content.append(section);
  }

  details.append(summary, content);
  bubble.append(details);
}

/**
 * One assistant or user bubble, with its own transient status/cursor state.
 */
export class MessageView {
  /**
   * @param {HTMLElement} row
   * @param {HTMLElement} bubble
   * @param {HTMLElement} body
   */
  constructor(row, bubble, body) {
    this.row = row;
    this.bubble = bubble;
    this.body = body;
    this.statusEl = null;
    this.cursor = null;
    this.received = false;
    this.text = '';
  }

  setStatus(text) {
    if (!this.statusEl) {
      this.statusEl = element('div', 'turn-status');
      const spinner = element('span', 'status-spinner');
      const textNode = element('span', 'status-text', text);
      this.statusEl.append(spinner, textNode);
      this.bubble.append(this.statusEl);
    } else {
      const textNode = this.statusEl.querySelector('.status-text');
      if (textNode) {
        textNode.textContent = text;
      } else {
        this.statusEl.textContent = text;
      }
    }
    this.statusEl.classList.remove('quiet');
  }

  addPlan(plan) {
    renderPlan(this.bubble, plan);
  }

  addSearchResults(groups) {
    renderSearchResults(this.bubble, groups);
  }

  appendToken(text) {
    if (!this.received) {
      this.received = true;
      if (this.statusEl) {
        this.statusEl.remove();
        this.statusEl = null;
      }
    }

    if (!this.cursor) {
      this.cursor = element('span', 'typing-cursor');
      this.body.append(this.cursor);
    }

    this.text += text;
    this.body.insertBefore(document.createTextNode(text), this.cursor);
  }

  /**
   * Stream plain text for speed, then render markdown once at the end. The
   * answer is untrusted, so the renderer builds nodes; no innerHTML anywhere.
   */
  complete() {
    this.finish();
    if (this.received && this.text.trim().length > 0) {
      this.body.replaceChildren(renderMarkdown(this.text));
    }
  }

  finish() {
    this.cursor?.remove();
    this.cursor = null;

    if (this.received) {
      this.statusEl?.remove();
      this.statusEl = null;
    } else {
      // Planner-only turns keep their final status line as a quiet note.
      this.statusEl?.classList.add('quiet');
    }
  }

  fail(message) {
    this.statusEl?.remove();
    this.statusEl = null;
    this.cursor?.remove();
    this.cursor = null;

    this.bubble.classList.add('error');

    if (!this.received) {
      this.body.textContent = `Error: ${message}`;
    } else {
      this.body.append(document.createTextNode(`\n\n[stopped: ${message}]`));
    }
  }
}

export class ChatView {
  /**
   * @param {{
   *   messagesEl: HTMLElement,
   *   emptyEl: HTMLElement,
   *   modeEl: HTMLElement,
   *   sessionEl: HTMLElement
   * }} elements
   */
  constructor(elements) {
    this.elements = elements;
  }

  addMessage(role, text = '') {
    if (this.elements.emptyEl) {
      this.elements.emptyEl.hidden = true;
    }

    const row = element('div', `msg-row ${role}`);
    const bubble = element('div', 'bubble');

    let body;
    if (role === 'assistant') {
      const whoHeader = element('div', 'who-header');
      const avatar = element('span', 'agent-avatar', 'm');
      const who = element('span', 'who', 'minimi');
      whoHeader.append(avatar, who);
      body = element('div', 'body', text);
      bubble.append(whoHeader, body);
    } else {
      const who = element('div', 'who', 'you');
      body = element('div', 'body', text);
      bubble.append(who, body);
    }

    row.append(bubble);
    this.elements.messagesEl.append(row);
    this.scrollToBottom();

    return new MessageView(row, bubble, body);
  }

  setMode(mode) {
    if (this.elements.modeEl) {
      this.elements.modeEl.textContent = mode;
      this.elements.modeEl.parentElement?.setAttribute('title', `Streaming mode: ${mode}`);
    }
  }

  showSession(id) {
    if (this.elements.sessionEl) {
      this.elements.sessionEl.textContent = id.slice(0, 8);
      this.elements.sessionEl.parentElement?.setAttribute('title', `Session ID: ${id}`);
    }
  }

  clear() {
    this.elements.messagesEl.replaceChildren();
    if (this.elements.emptyEl) {
      this.elements.emptyEl.hidden = false;
    }
  }

  scrollToBottom() {
    const chatViewport = document.getElementById('chat') || document.documentElement;
    requestAnimationFrame(() => {
      chatViewport.scrollTo({
        top: chatViewport.scrollHeight,
        behavior: 'smooth',
      });
    });
  }
}
