const META_REPLACE_CREATIVE_PATH = '/api/ads/replace-creative';
const GOOGLE_EXECUTE_REPLACEMENTS_PATH = '/api/ads/google/execute-replacements';

type TraceEntry = {
  step?: string;
  status?: string;
  timestamp?: string;
  [key: string]: unknown;
};

const parseMaybeJson = (value: string) => {
  try {
    return value ? JSON.parse(value) as unknown : null;
  } catch {
    return value;
  }
};

const summarizeRequestBody = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return payload;

  const body = { ...(payload as Record<string, unknown>) };
  const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl : '';
  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    body.imageDataUrl = {
      mimeType: match[1],
      approxBytes: Math.floor((match[2].length * 3) / 4),
      base64Chars: match[2].length,
    };
  } else if (imageDataUrl) {
    body.imageDataUrl = `[${imageDataUrl.length} chars]`;
  }

  return body;
};

const getRequestUrl = (input: RequestInfo | URL) => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const getRequestBody = async (input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof init?.body === 'string') return parseMaybeJson(init.body);
  if (input instanceof Request) {
    try {
      return parseMaybeJson(await input.clone().text());
    } catch {
      return null;
    }
  }
  return null;
};

const getAdsLogLabel = (url: string, body: unknown) => {
  if (url.includes(META_REPLACE_CREATIVE_PATH)) {
    const platform = body && typeof body === 'object'
      ? (body as { platform?: unknown }).platform
      : undefined;
    return platform === 'meta' ? 'Meta Ads Upload' : 'Ads Creative Upload';
  }

  if (url.includes(GOOGLE_EXECUTE_REPLACEMENTS_PATH)) return 'Google Ads Upload';
  if (url.includes('/api/ads/')) return 'Ads API';
  return null;
};

const logTraceTable = (trace: unknown) => {
  if (!Array.isArray(trace) || trace.length === 0) return;
  console.table(trace as TraceEntry[]);
};

const getTraceFromPayload = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return [];
  const objectPayload = payload as {
    results?: Array<{
      executionError?: { googleAdsTrace?: TraceEntry[]; metaAdsTrace?: TraceEntry[] };
      googleAdsTrace?: TraceEntry[];
      metaAdsTrace?: TraceEntry[];
      replacement?: { googleAdsTrace?: TraceEntry[]; metaAdsTrace?: TraceEntry[] };
    }>;
    metaAdsTrace?: TraceEntry[];
    googleAdsTrace?: TraceEntry[];
    details?: { metaAdsTrace?: TraceEntry[] };
  };
  const resultTraces = (objectPayload.results || []).flatMap((result) => [
    ...(result.googleAdsTrace || []),
    ...(result.metaAdsTrace || []),
    ...(result.executionError?.googleAdsTrace || []),
    ...(result.executionError?.metaAdsTrace || []),
    ...(result.replacement?.googleAdsTrace || []),
    ...(result.replacement?.metaAdsTrace || []),
  ]);
  return [
    ...(objectPayload.googleAdsTrace || []),
    ...(objectPayload.metaAdsTrace || []),
    ...(objectPayload.details?.metaAdsTrace || []),
    ...resultTraces,
  ];
};

const getFailedResults = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return [];
  const objectPayload = payload as {
    results?: Array<{ executionStatus?: string; executionMessage?: string; executionError?: unknown }>;
  };

  return (objectPayload.results || []).filter((result) => result.executionStatus === 'failed');
};

const hasPayloadFailure = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return false;
  const objectPayload = payload as {
    summary?: { failed?: number; storageFailed?: number };
    totals?: { storageFailed?: number };
  };

  return (
    Number(objectPayload.summary?.failed || 0) > 0 ||
    Number(objectPayload.summary?.storageFailed || 0) > 0 ||
    Number(objectPayload.totals?.storageFailed || 0) > 0 ||
    getFailedResults(payload).length > 0
  );
};

export const installMetaAdsConsoleLogger = () => {
  const windowWithFlag = window as typeof window & {
    __metaAdsConsoleLoggerInstalled?: boolean;
  };

  if (windowWithFlag.__metaAdsConsoleLoggerInstalled) return;
  windowWithFlag.__metaAdsConsoleLoggerInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = getRequestUrl(input);
    const body = await getRequestBody(input, init);
    const label = getAdsLogLabel(url, body);

    if (!label) {
      return originalFetch(input, init);
    }

    const startedAt = performance.now();
    console.info(`[${label}] REQUEST`, {
      url,
      method: init?.method || (input instanceof Request ? input.method : 'GET'),
      body: summarizeRequestBody(body),
    });

    let response: Response;
    try {
      response = await originalFetch(input, init);
    } catch (error) {
      console.error(`[${label}] NETWORK ERROR`, { url, error });
      throw error;
    }

    const rawPayload = await response.clone().text();
    const payload = parseMaybeJson(rawPayload);
    const trace = getTraceFromPayload(payload);
    const failedResults = getFailedResults(payload);
    const logPayload = {
      url,
      status: response.status,
      statusText: response.statusText,
      elapsedMs: Math.round(performance.now() - startedAt),
      payload,
      trace,
      failedResults,
    };

    if (response.ok && !hasPayloadFailure(payload)) {
      console.info(`[${label}] SUCCESS`, logPayload);
    } else {
      console.error(`[${label}] FAILED`, logPayload);
    }
    logTraceTable(trace);

    return response;
  };
};
