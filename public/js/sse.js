/**
 * SSE framing for POST /chat.
 *
 * Kept as a pure parser so the protocol can be tested in Node without a DOM:
 * frames arrive split at arbitrary byte offsets, so buffering is the whole job.
 */

/**
 * @param {(event: any) => void} onEvent
 */
export function createSseParser(onEvent) {
  let buffer = '';

  function emit(frame) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');

    if (data.length === 0) return;

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      // Malformed frame: drop it. Do not let a bad byte kill the stream.
      return;
    }

    // Deliberately outside the try/catch: a handler throwing (for example on
    // {type:"error"}) must interrupt the stream, not be silently swallowed.
    onEvent(event);
  }

  return {
    /** Feed a decoded chunk. Emits every complete frame it can. */
    push(chunk) {
      // Normalise after concatenation so a CRLF split across two chunks works.
      buffer = (buffer + chunk).replace(/\r\n/g, '\n');

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        emit(frame);
      }
    },

    /** Emit a trailing frame that arrived without its blank-line terminator. */
    flush() {
      if (buffer.trim().length === 0) return;
      const frame = buffer;
      buffer = '';
      emit(frame);
    },
  };
}

/**
 * Read a fetch Response body to completion, emitting parsed SSE events.
 *
 * @param {Response} response
 * @param {(event: any) => void} onEvent
 */
export async function readSse(response, onEvent) {
  if (!response.body) {
    throw new Error('Response has no body to stream');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(onEvent);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }

    parser.push(decoder.decode());
    parser.flush();
  } finally {
    // After a normal finish this is a no-op; after a handler throw it closes
    // the connection so the server stops generating tokens.
    reader.cancel().catch(() => {});
  }
}
