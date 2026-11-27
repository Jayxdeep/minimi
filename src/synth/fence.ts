/**
 * Splits a streamed synthesis into (a) answer markdown that is safe to show and
 * (b) the trailing fenced JSON trailer that must never reach the UI.
 *
 * The only hard part is not leaking a partial fence: a chunk can end with
 * "````" or "```js" and the next chunk finishes the fence. So a possible
 * fence line is held back until it is resolved one way or the other.
 */

const FENCE_TOKEN = '```json';
const OPENER = /^[ \t]*```json[ \t]*\r?\n/im;

/** Is this tail a prefix of a fence opener line? */
export function looksLikePartialFence(tail: string): boolean {
  if (tail.length === 0) return false;

  const withoutLeading = tail.replace(/^[ \t]+/, '');
  const core = withoutLeading.trimEnd();
  if (core.length === 0 || core.length > FENCE_TOKEN.length) return false;

  return FENCE_TOKEN.startsWith(core.toLowerCase());
}

export interface SplitResult {
  answer: string;
  /** Text still in answer mode at finish time (must be emitted). */
  remainder: string;
  /** Raw text after the opener line, including the closing fence. */
  trailerText: string | null;
}

export class AnswerSplitter {
  private buffer = '';
  private answer = '';
  private state: 'answer' | 'trailer' = 'answer';

  /** Returns answer text that is safe to stream now. */
  push(chunk: string): string {
    if (this.state === 'trailer') {
      this.buffer += chunk;
      return '';
    }

    this.buffer += chunk;

    const opener = OPENER.exec(this.buffer);
    if (opener) {
      const out = this.buffer.slice(0, opener.index);
      this.buffer = this.buffer.slice(opener.index + opener[0].length);
      this.state = 'trailer';
      this.answer += out;
      return out;
    }

    const lineStart = this.buffer.lastIndexOf('\n') + 1;
    const tail = this.buffer.slice(lineStart);
    const cutoff = looksLikePartialFence(tail) ? lineStart : this.buffer.length;

    const out = this.buffer.slice(0, cutoff);
    this.buffer = this.buffer.slice(cutoff);
    this.answer += out;
    return out;
  }

  finish(): SplitResult {
    let remainder = '';
    if (this.state === 'answer') {
      remainder = this.buffer;
      this.answer += remainder;
      this.buffer = '';
    }

    return {
      answer: this.answer,
      remainder,
      trailerText: this.state === 'trailer' ? this.buffer : null,
    };
  }
}
