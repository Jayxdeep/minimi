/**
 * HTTP transport. One endpoint, one error shape.
 */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {unknown} detail
   */
  constructor(message, status, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * @param {{ sessionId: string, message: string, userTz: string, signal?: AbortSignal }} input
 * @returns {Promise<Response>} an open SSE stream
 */
export async function sendChat(input) {
  const response = await fetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: input.sessionId,
      message: input.message,
      userTz: input.userTz,
    }),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const code =
      detail && typeof detail === 'object' && 'error' in detail
        ? String(detail.error)
        : null;
    throw new ApiError(
      code ? `Request rejected: ${code}` : `Request failed (${response.status})`,
      response.status,
      detail,
    );
  }

  return response;
}

export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
