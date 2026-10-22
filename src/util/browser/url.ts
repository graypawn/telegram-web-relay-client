import { DEBUG } from '../../config';
import convertPunycode from '../../lib/punycode';

const PROTOCOL_WHITELIST = new Set(['http:', 'https:', 'tg:', 'ton:', 'mailto:', 'tel:']);
const FALLBACK_PREFIX = 'https://';
const PROTOCOL_PREFIX_PATTERN = /^[a-z][a-z\d+.-]*:/i;

function normalizeProtocol(protocol: string) {
  return protocol.replace(/:$/, '').trim().toLowerCase();
}

export function ensureProtocol(url: string) {
  try {
    const parsedUrl = new URL(url);

    if (!PROTOCOL_WHITELIST.has(parsedUrl.protocol)) {
      return `${FALLBACK_PREFIX}${url}`;
    }

    return url;
  } catch (err) {
    return `${FALLBACK_PREFIX}${url}`;
  }
}

export function getUnicodeUrl(url: string) {
  const href = ensureProtocol(url);

  try {
    const parsedUrl = new URL(href);
    const unicodeDomain = convertPunycode(parsedUrl.hostname);

    try {
      return decodeURI(parsedUrl.toString()).replace(parsedUrl.hostname, unicodeDomain);
    } catch (err) { // URL contains invalid sequences, keep it as it is
      return parsedUrl.toString().replace(parsedUrl.hostname, unicodeDomain);
    }
  } catch (error) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.warn('SafeLink.getDecodedUrl error ', url, error);
    }
  }

  return undefined;
}

export function isMixedScriptUrl(url: string): boolean {
  const protocol = url.match(PROTOCOL_PREFIX_PATTERN)?.[0].toLowerCase();
  const urlToParse = protocol && PROTOCOL_WHITELIST.has(protocol) ? url : ensureProtocol(url);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlToParse);
  } catch (e) {
    return true; // If URL is invalid, treat it as mixed script
  }

  // `trusted.example@evil.example`처럼 표시 대상과 실제 호스트가 다른 링크는 항상 확인한다.
  if (parsedUrl.username || parsedUrl.password) {
    return true;
  }

  let domain;
  try {
    domain = convertPunycode(parsedUrl.hostname);
  } catch (e) {
    return true;
  }

  let hasLatin = false;
  let hasNonLatin = false;

  for (const char of Array.from(domain)) {
    if (!/\p{L}/u.test(char)) continue; // Ignore non-letter characters

    if (/\p{Script=Latin}/u.test(char)) {
      hasLatin = true;
    } else {
      hasNonLatin = true;
    }

    if (hasLatin && hasNonLatin) return true;
  }

  return false;
}

export function isValidProtocol(url: string, allowedProtocols: string[]) {
  if (typeof url !== 'string') {
    return false;
  }

  try {
    const parsedUrl = new URL(url);

    return allowedProtocols.includes(normalizeProtocol(parsedUrl.protocol));
  } catch (err) {
    return false;
  }
}
