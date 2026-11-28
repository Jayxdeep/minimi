import { browserTimezone, sendChat } from './api.js';
import { getSessionId, resetSessionId } from './session.js';
import { readSse } from './sse.js';
import { ChatView } from './ui.js';

const inputEl = document.getElementById('input');
const formEl = document.getElementById('composer');
const sendEl = document.getElementById('send');
const newSessionEl = document.getElementById('new-session');

const view = new ChatView({
  messagesEl: document.getElementById('messages'),
  emptyEl: document.getElementById('empty'),
  modeEl: document.getElementById('mode'),
  sessionEl: document.getElementById('session-label'),
});

let streaming = false;

function setStreaming(value) {
  streaming = value;
  sendEl.disabled = value;
  inputEl.disabled = value;
  const labelEl = sendEl.querySelector('.send-label');
  if (labelEl) {
    labelEl.textContent = value ? '…' : 'Send';
  } else {
    sendEl.textContent = value ? '…' : 'Send';
  }
  document.getElementById('chat')?.setAttribute('aria-busy', String(value));
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`;
}

/**
 * One turn: POST, consume SSE, update the bubble.
 */
async function runTurn(text) {
  view.addMessage('user', text);
  const target = view.addMessage('assistant', '');
  target.setStatus('connecting…');
  setStreaming(true);

  try {
    const response = await sendChat({
      sessionId: getSessionId(),
      message: text,
      userTz: browserTimezone(),
    });

    await readSse(response, (event) => {
      switch (event.type) {
        case 'status':
          target.setStatus(event.text);
          break;

        case 'plan':
          target.addPlan(event.plan);
          view.setMode('planner');
          view.scrollToBottom();
          break;

        case 'searching': {
          const count = Array.isArray(event.queries) ? event.queries.length : 0;
          target.setStatus(
            `searching ${count} ${count === 1 ? 'query' : 'queries'}…`,
          );
          break;
        }

        case 'search_results':
          target.setSources(event.data || []);
          view.setMode('search');
          view.scrollToBottom();
          break;

        case 'token':
          target.appendToken(event.text);
          view.scrollToBottom();
          break;

        case 'error':
          throw new Error(event.message);

        case 'done':
          target.complete();
          break;

        default:
          break;
      }
    });
  } catch (error) {
    target.fail(error instanceof Error ? error.message : String(error));
  } finally {
    target.finish();
    setStreaming(false);
    inputEl.focus();
  }
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  if (streaming) return;

  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = '';
  autoGrow();
  void runTurn(text);
});

inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});

inputEl.addEventListener('input', autoGrow);

newSessionEl.addEventListener('click', () => {
  if (streaming) return;
  view.clear();
  view.showSession(resetSessionId());
  inputEl.focus();
});

// Setup prompt suggestions from the empty state
document.querySelectorAll('.suggestion-card').forEach((card) => {
  card.addEventListener('click', () => {
    if (streaming) return;
    const prompt = card.getAttribute('data-prompt');
    if (prompt) {
      inputEl.value = prompt;
      autoGrow();
      formEl.requestSubmit();
    }
  });
});

view.showSession(getSessionId());
inputEl.focus();
