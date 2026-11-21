/**
 * Presentation layer. Owns every DOM node the chat needs and no transport
 * logic: given an event, update a bubble.
 */

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
  return match ? `${match[1]} ${match[2]}` : String(iso || '?');
}

function chip(text) {
  return element('span', 'chip', text);
}

function section(label, chips) {
  const wrap = document.createElement('div');
  const head = element('div', 'plan-label', label);
  const line = element('div', 'plan-line');
  line.append(...(chips.length > 0 ? chips : [chip('—')]));
  wrap.append(head, line);
  return wrap;
}

/** Render the planner output as a compact card plus raw JSON on demand. */
export function renderPlan(bubble, plan) {
  const details = document.createElement('details');
  details.className = 'plan';
  details.open = true;

  const summary = document.createElement('summary');
  const caret = element('span', 'caret', '▸');
  const title = element('span', '', 'plan');
  const intent = document.createElement('em');
  intent.textContent = plan.intent || 'unknown';
  summary.append(caret, title, intent);

  const body = element('div', 'plan-body');

  const refs = (plan.temporal_refs || []).map((ref) =>
    chip(`${ref.expression} → ${shortStamp(ref.resolved_range[0])}`),
  );
  body.append(section('time', refs));

  const memoryWindow = plan.memory && plan.memory.window;
  body.append(
    section(
      'memory window',
      memoryWindow
        ? [chip(`${shortStamp(memoryWindow[0])} → ${shortStamp(memoryWindow[1])}`)]
        : [],
    ),
  );

  body.append(
    section(
      'recall keywords',
      ((plan.memory && plan.memory.keywords) || []).map((keyword) => chip(keyword)),
    ),
  );

  body.append(
    section(
      're-verify',
      (plan.verify_snapshot_ids || []).map((id) =>
        chip(`snapshot ${String(id).slice(0, 8)}`),
      ),
    ),
  );

  const searchWrap = document.createElement('div');
  const searchHead = element('div', 'plan-label', 'search plan');
  const list = document.createElement('ol');
  const queries = plan.search_plan || [];

  if (queries.length === 0) {
    const item = document.createElement('li');
    item.textContent = 'no searches';
    list.append(item);
  } else {
    for (const query of queries) {
      const item = document.createElement('li');
      item.append(document.createTextNode(query.query));
      const cite = document.createElement('cite');
      cite.textContent = query.mode + (query.since ? ` · since ${query.since}` : '');
      item.append(cite);
      list.append(item);
    }
  }

  searchWrap.append(searchHead, list);
  body.append(searchWrap);

  const rawWrap = document.createElement('details');
  rawWrap.className = 'raw';
  const rawSummary = document.createElement('summary');
  rawSummary.textContent = 'raw json';
  const raw = document.createElement('pre');
  raw.textContent = JSON.stringify(plan, null, 2);
  rawWrap.append(rawSummary, raw);

  details.append(summary, body, rawWrap);
  bubble.append(details);
}

/**
 * One assistant or user bubble, with its own transient status/cursor state.
 * Keeping this state here (rather than in the turn runner) means "was a token
 * received?" is answered in exactly one place.
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
  }

  setStatus(text) {
    if (!this.statusEl) {
      this.statusEl = element('div', 'status');
      this.bubble.append(this.statusEl);
    }
    this.statusEl.textContent = text;
    this.statusEl.classList.remove('quiet');
  }

  addPlan(plan) {
    renderPlan(this.bubble, plan);
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
      this.cursor = element('span', 'cursor');
      this.body.append(this.cursor);
    }

    this.body.insertBefore(document.createTextNode(text), this.cursor);
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
    this.elements.emptyEl.hidden = true;

    const row = element('div', `row ${role}`);
    const bubble = element('div', 'bubble');
    const who = element('div', 'who', role === 'user' ? 'you' : 'minimi');
    const body = element('div', 'body', text);

    bubble.append(who, body);
    row.append(bubble);
    this.elements.messagesEl.append(row);
    this.scrollToBottom();

    return new MessageView(row, bubble, body);
  }

  setMode(mode) {
    this.elements.modeEl.textContent = mode;
    this.elements.modeEl.title = `Streaming mode: ${mode}`;
  }

  showSession(id) {
    this.elements.sessionEl.textContent = id.slice(0, 8);
    this.elements.sessionEl.title = id;
  }

  clear() {
    this.elements.messagesEl.replaceChildren();
    this.elements.emptyEl.hidden = false;
  }

  scrollToBottom() {
    const distance =
      document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
    if (distance < 240) {
      window.scrollTo({ top: document.documentElement.scrollHeight });
    }
  }
}
