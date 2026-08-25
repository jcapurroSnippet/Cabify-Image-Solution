import type {
  CreateRunInput,
  CreativeRun,
  RunDetail,
  RunExecutionResponse,
  RunGenerationEvent,
  RunPlanResponse,
  SubmitReviewResponse,
  SyncRunResponse,
} from '../types';
import type { LowPerformerCategories } from '../../creative-library/services/creativeLibraryApi';

const parseErrorMessage = async (response: Response, url: string): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: string; details?: { message?: string } };
    console.error('[Run] API error', { url, status: response.status, payload });
    return [payload.error || `Request failed with status ${response.status}.`, payload.details?.message]
      .filter(Boolean)
      .join('\n');
  } catch {
    console.error('[Run] API error', { url, status: response.status, statusText: response.statusText });
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
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(await parseErrorMessage(response, url));
  return (await response.json()) as T;
};

export const createRun = async (input: CreateRunInput): Promise<CreativeRun> =>
  postJson<CreativeRun>('/api/runs', input);

export const fetchRuns = async (sheetsUrl?: string): Promise<CreativeRun[]> => {
  const params = sheetsUrl ? `?${new URLSearchParams({ sheetsUrl }).toString()}` : '';
  const data = await getJson<{ runs: CreativeRun[] }>(`/api/runs${params}`);
  return data.runs || [];
};

export const fetchRun = async (runId: string, sheetsUrl?: string): Promise<RunDetail> => {
  const params = sheetsUrl ? `?${new URLSearchParams({ sheetsUrl }).toString()}` : '';
  return getJson<RunDetail>(`/api/runs/${encodeURIComponent(runId)}${params}`);
};

export const detectRunTargets = async (
  runId: string,
  sheetsUrl?: string,
): Promise<RunDetail & { detected: number }> =>
  postJson<RunDetail & { detected: number }>(`/api/runs/${encodeURIComponent(runId)}/detect`, { sheetsUrl });

export const submitRunForReview = async (runId: string, sheetsUrl?: string): Promise<SubmitReviewResponse> =>
  postJson<SubmitReviewResponse>(`/api/runs/${encodeURIComponent(runId)}/submit-review`, { sheetsUrl });

export const markRunSent = async (runId: string, sheetsUrl?: string): Promise<{ run: CreativeRun }> =>
  postJson<{ run: CreativeRun }>(`/api/runs/${encodeURIComponent(runId)}/mark-sent`, { sheetsUrl });

export const syncRunFromReview = async (runId: string, sheetsUrl?: string): Promise<SyncRunResponse> =>
  postJson<SyncRunResponse>(`/api/runs/${encodeURIComponent(runId)}/sync`, { sheetsUrl });

export const buildRunPlan = async (
  runId: string,
  sheetsUrl?: string,
  lowPerformerCategories?: LowPerformerCategories,
): Promise<RunPlanResponse> =>
  postJson<RunPlanResponse>(`/api/runs/${encodeURIComponent(runId)}/plan`, { sheetsUrl, lowPerformerCategories });

export const executeRunPlacement = async (
  runId: string,
  sheetsUrl: string | undefined,
  selectedOperationIds: string[],
  lowPerformerCategories?: LowPerformerCategories,
  allowNewAdCreation = false,
): Promise<RunExecutionResponse> =>
  postJson<RunExecutionResponse>(`/api/runs/${encodeURIComponent(runId)}/execute`, {
    sheetsUrl,
    selectedOperationIds,
    lowPerformerCategories,
    allowNewAdCreation,
    confirm: true,
  });

/**
 * Drive step 2. The server streams NDJSON because a run can hold many targets
 * and each one costs three model calls per ratio; the same reader shape as the
 * aspect-ratio batch tool.
 */
export const streamRunGeneration = async (
  runId: string,
  sheetsUrl: string | undefined,
  onEvent: (event: RunGenerationEvent) => void,
): Promise<void> => {
  const url = `/api/runs/${encodeURIComponent(runId)}/generate`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sheetsUrl }),
  });

  if (!response.ok) throw new Error(await parseErrorMessage(response, url));

  const emit = (line: string) => {
    if (!line.trim()) return;
    try {
      onEvent(JSON.parse(line) as RunGenerationEvent);
    } catch (error) {
      console.error('[Run] Failed to parse generation event', error, line);
    }
  };

  const reader = response.body?.getReader();
  if (!reader) {
    (await response.text()).split('\n').forEach(emit);
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      emit(buffer);
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(emit);
  }
};
