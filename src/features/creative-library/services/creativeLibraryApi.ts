import type {
  AccountOption,
  CampaignOption,
  CreativeLibraryResponse,
  ExecutionResponse,
  LowPerformer,
  ReplacementPlanResponse,
  ReplacementMode,
  SyncResponse,
} from '../types';

export type LowPerformerCategories = Record<string, string>;

const parseErrorMessage = async (response: Response, url: string): Promise<string> => {
  try {
    const payload = (await response.json()) as {
      error?: string;
      debugLogPath?: string;
      details?: { message?: string };
    };
    console.error('[Creative Library] API error', {
      url,
      status: response.status,
      statusText: response.statusText,
      payload,
    });
    return [
      payload.error || `Request failed with status ${response.status}.`,
      payload.details?.message,
      payload.debugLogPath ? `Log: ${payload.debugLogPath}` : '',
    ].filter(Boolean).join('\n');
  } catch {
    console.error('[Creative Library] API error', {
      url,
      status: response.status,
      statusText: response.statusText,
    });
    return `Request failed with status ${response.status}.`;
  }
};

const getJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await parseErrorMessage(response, url));
  return (await response.json()) as T;
};

const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(await parseErrorMessage(response, url));
  return (await response.json()) as T;
};

export const fetchGoogleAccounts = async (): Promise<AccountOption[]> => {
  const data = await getJson<{ accounts: AccountOption[] }>('/api/ads/accounts?platform=google');
  return data.accounts || [];
};

export const fetchGoogleCampaigns = async (accountId: string): Promise<CampaignOption[]> => {
  const params = new URLSearchParams({ platform: 'google', accountId });
  const data = await getJson<{ campaigns: CampaignOption[] }>(`/api/ads/campaigns?${params.toString()}`);
  return data.campaigns || [];
};

export const syncCreativeLibrary = async (sheetsUrl: string, sheetName?: string): Promise<SyncResponse> => {
  const url = '/api/creative-library/sync';
  const body = { sheetsUrl, sheetName };
  const startedAt = performance.now();

  console.info('[Creative Library] Sync request', body);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error('[Creative Library] Sync network error', error);
    throw error;
  }

  const rawPayload = await response.text();
  let payload: unknown = rawPayload;
  try {
    payload = rawPayload ? JSON.parse(rawPayload) : null;
  } catch {
    payload = rawPayload;
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  const logPayload = {
    url,
    status: response.status,
    statusText: response.statusText,
    elapsedMs,
    payload,
  };

  if (!response.ok) {
    console.error('[Creative Library] Sync HTTP error', logPayload);
    const errorPayload = typeof payload === 'object' && payload !== null
      ? payload as { error?: string; debugLogPath?: string; details?: { message?: string } }
      : {};
    throw new Error([
      errorPayload.error || `Request failed with status ${response.status}.`,
      errorPayload.details?.message,
      errorPayload.debugLogPath ? `Log: ${errorPayload.debugLogPath}` : '',
    ].filter(Boolean).join('\n'));
  }

  const result = payload as SyncResponse;
  console.info('[Creative Library] Sync response', logPayload);
  if (result.failureDetails?.length || (result.totals?.storageFailed ?? 0) > 0) {
    console.error('[Creative Library] Sync storage failures', {
      storageFailed: result.totals?.storageFailed ?? 0,
      failureDetails: result.failureDetails || [],
      rows: result.rows?.filter((row) => (row.counts?.storageFailed || 0) > 0 || row.notes?.length > 0) || [],
    });
  }

  return result;
};

export const fetchCreativeLibrary = async (sheetsUrl: string): Promise<CreativeLibraryResponse> => {
  const params = new URLSearchParams({ sheetsUrl });
  return getJson<CreativeLibraryResponse>(`/api/creative-library?${params.toString()}`);
};

export const fetchLowPerformers = async (
  sheetsUrl: string,
  accountId: string,
  campaignIds: string[],
  limit: number,
): Promise<{ assets: LowPerformer[]; categories: string[] }> => {
  const data = await postJson<{ assets: LowPerformer[]; categories: string[] }>('/api/ads/google/low-performers', {
    sheetsUrl,
    accountId,
    campaignIds: campaignIds.length > 0 ? campaignIds : undefined,
    limit,
  });
  return {
    assets: data.assets || [],
    categories: data.categories || [],
  };
};

export const buildReplacementPlan = async (
  sheetsUrl: string,
  accountId: string,
  campaignIds: string[],
  limit: number,
  selectedLowPerformerIds?: string[],
  lowPerformerCategories?: LowPerformerCategories,
  replacementMode?: ReplacementMode,
): Promise<ReplacementPlanResponse> =>
  postJson<ReplacementPlanResponse>('/api/ads/google/replacement-plan', {
    sheetsUrl,
    accountId,
    campaignIds: campaignIds.length > 0 ? campaignIds : undefined,
    limit,
    selectedLowPerformerIds,
    lowPerformerCategories,
    replacementMode,
  });

export const executeReplacements = async (
  sheetsUrl: string,
  accountId: string,
  campaignIds: string[],
  limit: number,
  selectedOperationIds: string[],
  selectedLowPerformerIds?: string[],
  lowPerformerCategories?: LowPerformerCategories,
  replacementMode?: ReplacementMode,
): Promise<ExecutionResponse> =>
  postJson<ExecutionResponse>('/api/ads/google/execute-replacements', {
    sheetsUrl,
    accountId,
    campaignIds: campaignIds.length > 0 ? campaignIds : undefined,
    limit,
    selectedOperationIds,
    selectedLowPerformerIds,
    lowPerformerCategories,
    replacementMode,
    confirm: true,
  });
