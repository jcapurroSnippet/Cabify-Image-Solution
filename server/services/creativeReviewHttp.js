import crypto from 'node:crypto';

const DEFAULT_COOKIE_NAME = 'cabify_creative_review';
const DEFAULT_PREVIEW_AUTH_TTL_MS = 10_000;
const MAX_PREVIEW_AUTH_CACHE_ENTRIES = 500;

const clean = (value) => String(value ?? '').trim();

export const getCreativeReviewCookieName = () =>
  clean(process.env.CREATIVE_REVIEW_COOKIE_NAME) || DEFAULT_COOKIE_NAME;

export const parseCookies = (cookieHeader = '') => {
  const cookies = {};
  for (const segment of String(cookieHeader || '').split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    const name = segment.slice(0, separator).trim();
    if (!name) continue;
    const rawValue = segment.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
};

export const getCreativeReviewSessionToken = (request) => {
  const cookies = parseCookies(request?.headers?.cookie || '');
  return clean(cookies[getCreativeReviewCookieName()]);
};

export const normalizeCreativeReviewDecisionPayload = (body = {}) => (
  Array.isArray(body?.decisions)
    ? body.decisions.map((decision) => ({
        reviewItemId: decision.reviewItemId || decision.itemId || decision.id,
        status: decision.status || decision.decision,
        reason: decision.reason ?? decision.feedback,
        expectedVersion: decision.expectedVersion ?? decision.expected_version ?? decision.version,
      }))
    : body?.decisions
);

export const serializeCreativeReviewSession = ({
  token,
  expiresAt,
  secure = process.env.NODE_ENV === 'production',
} = {}) => {
  const expires = new Date(expiresAt || 0);
  if (!token || !Number.isFinite(expires.getTime())) {
    throw new Error('A review token and valid expiry are required to create a session.');
  }

  const maxAgeSeconds = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000));
  return [
    `${getCreativeReviewCookieName()}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    `Expires=${expires.toUTCString()}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
};

export const clearCreativeReviewSession = ({
  secure = process.env.NODE_ENV === 'production',
} = {}) => [
  `${getCreativeReviewCookieName()}=`,
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  'Max-Age=0',
  'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ...(secure ? ['Secure'] : []),
].join('; ');

const previewAuthorizationCache = new Map();
const previewAuthorizationLoads = new Map();

const getPreviewCacheKey = (token) =>
  crypto.createHash('sha256').update(clean(token), 'utf8').digest('hex');

const getPreviewUrlsFromPayload = (payload) => new Set(
  (payload?.items || []).flatMap((item) => [
    clean(item?.image_url || item?.imageUrl),
    clean(item?.reference_url || item?.referenceUrl),
  ]).filter(Boolean),
);

const getPreviewAuthorizationTtlMs = () => {
  const seconds = Number(process.env.CREATIVE_REVIEW_PREVIEW_AUTH_TTL_SECONDS || 10);
  return Number.isFinite(seconds)
    ? Math.min(60_000, Math.max(1_000, seconds * 1000))
    : DEFAULT_PREVIEW_AUTH_TTL_MS;
};

const prunePreviewAuthorizationCache = (now) => {
  for (const [key, entry] of previewAuthorizationCache) {
    if (entry.expiresAt <= now) previewAuthorizationCache.delete(key);
  }
  while (previewAuthorizationCache.size >= MAX_PREVIEW_AUTH_CACHE_ENTRIES) {
    const oldestKey = previewAuthorizationCache.keys().next().value;
    if (!oldestKey) break;
    previewAuthorizationCache.delete(oldestKey);
  }
};

export const cacheCreativeReviewPreviewAuthorization = ({ token, payload, now = Date.now() }) => {
  if (!clean(token)) return new Set();
  prunePreviewAuthorizationCache(now);
  const urls = getPreviewUrlsFromPayload(payload);
  previewAuthorizationCache.set(getPreviewCacheKey(token), {
    urls,
    expiresAt: now + getPreviewAuthorizationTtlMs(),
  });
  return urls;
};

export const getCreativeReviewPreviewAuthorization = async ({ token, load, now = Date.now() }) => {
  if (!clean(token)) return new Set();
  const key = getPreviewCacheKey(token);
  const cached = previewAuthorizationCache.get(key);
  if (cached && cached.expiresAt > now) return cached.urls;
  if (previewAuthorizationLoads.has(key)) return previewAuthorizationLoads.get(key);

  const pending = Promise.resolve()
    .then(load)
    .then((payload) => cacheCreativeReviewPreviewAuthorization({ token, payload }))
    .finally(() => previewAuthorizationLoads.delete(key));
  previewAuthorizationLoads.set(key, pending);
  return pending;
};

export const clearCreativeReviewPreviewAuthorization = (token) => {
  if (!clean(token)) return;
  const key = getPreviewCacheKey(token);
  previewAuthorizationCache.delete(key);
  previewAuthorizationLoads.delete(key);
};

export const isCreativeReviewWriterAuthorized = ({
  providedSecret,
  configuredSecret = process.env.CREATIVE_REVIEW_WRITER_SECRET,
} = {}) => {
  const expected = Buffer.from(clean(configuredSecret), 'utf8');
  const actual = Buffer.from(clean(providedSecret), 'utf8');
  return expected.length >= 32
    && actual.length === expected.length
    && crypto.timingSafeEqual(actual, expected);
};

const REVIEW_RUNTIME_API_PATHS = new Set([
  '/api/creative-reviews/session',
  '/api/creative-reviews/public',
  '/api/creative-reviews/public/decisions',
  '/api/creative-reviews/public/finalize',
  '/api/creative-reviews/internal/writer',
  '/api/image-preview',
]);

export const isReviewRuntimeApiAllowed = (path = '') =>
  REVIEW_RUNTIME_API_PATHS.has(String(path || '').replace(/\/+$/, '') || '/');
