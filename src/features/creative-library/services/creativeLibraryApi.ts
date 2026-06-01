import type {
  AccountOption,
  CampaignOption,
  CreativeLibraryResponse,
  ExecutionResponse,
  LowPerformer,
  ReplacementPlanResponse,
  SyncResponse,
} from '../types';

export type LowPerformerCategories = Record<string, string>;

const parseErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || `Request failed with status ${response.status}.`;
  } catch {
    return `Request failed with status ${response.status}.`;
  }
};

const getJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await parseErrorMessage(response));
  return (await response.json()) as T;
};

const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(await parseErrorMessage(response));
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

export const syncCreativeLibrary = async (sheetsUrl: string, sheetName?: string): Promise<SyncResponse> =>
  postJson<SyncResponse>('/api/creative-library/sync', { sheetsUrl, sheetName });

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
): Promise<ReplacementPlanResponse> =>
  postJson<ReplacementPlanResponse>('/api/ads/google/replacement-plan', {
    sheetsUrl,
    accountId,
    campaignIds: campaignIds.length > 0 ? campaignIds : undefined,
    limit,
    selectedLowPerformerIds,
    lowPerformerCategories,
  });

export const executeReplacements = async (
  sheetsUrl: string,
  accountId: string,
  campaignIds: string[],
  limit: number,
  selectedOperationIds: string[],
  selectedLowPerformerIds?: string[],
  lowPerformerCategories?: LowPerformerCategories,
): Promise<ExecutionResponse> =>
  postJson<ExecutionResponse>('/api/ads/google/execute-replacements', {
    sheetsUrl,
    accountId,
    campaignIds: campaignIds.length > 0 ? campaignIds : undefined,
    limit,
    selectedOperationIds,
    selectedLowPerformerIds,
    lowPerformerCategories,
    confirm: true,
  });
