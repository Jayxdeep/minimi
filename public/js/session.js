/**
 * Session identity.
 *
 * Memory is global across sessions on the server; this id only marks where a
 * conversation started. It lives in localStorage so a page refresh continues
 * the same conversation, while "New session" starts a fresh episode boundary.
 */

const STORAGE_KEY = 'minimi.sessionId';

let memoryFallback = null;

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(id) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private mode / storage disabled: keep working for this page load.
    memoryFallback = id;
  }
}

export function newSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getSessionId() {
  const existing = readStored() ?? memoryFallback;
  if (existing) return existing;

  const id = newSessionId();
  writeStored(id);
  return id;
}

export function resetSessionId() {
  const id = newSessionId();
  writeStored(id);
  return id;
}
