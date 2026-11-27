/** URL helpers shared by search-result links and rendered markdown. */

export function safeUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

export function prettyUrl(href) {
  try {
    const url = new URL(href);
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return url.hostname.replace(/^www\./, '') + path;
  } catch {
    return href;
  }
}
