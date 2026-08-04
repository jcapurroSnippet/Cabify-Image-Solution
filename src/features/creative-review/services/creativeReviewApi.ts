import type {
  BatchActionResponse,
  CreateReviewBatchInput,
  CreativeReviewBatch,
  CreativeReviewItem,
  CreativeReviewPayload,
  FinalizeReviewInput,
  ImportLegacyReviewInput,
  ImportLegacyReviewResponse,
  LegacyImportBackup,
  LegacyImportWarning,
  ReviewBatchStatus,
  ReviewDecisionInput,
  ReviewItemStatus,
  ReviewPublicationStatus,
  ReviewSourceType,
  ReviewSummary,
} from '../types';

type JsonRecord = Record<string, unknown>;

const EMPTY_SUMMARY: ReviewSummary = {
  total: 0,
  pending: 0,
  approved: 0,
  rejected: 0,
  superseded: 0,
  stored: 0,
  failed: 0,
};

const asRecord = (value: unknown): JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : {};

const readValue = (record: JsonRecord, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
};

const readString = (record: JsonRecord, ...keys: string[]): string => {
  const value = readValue(record, ...keys);
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(', ');
  return value === undefined ? '' : String(value);
};

const readNumber = (record: JsonRecord, fallback: number, ...keys: string[]): number => {
  const value = Number(readValue(record, ...keys));
  return Number.isFinite(value) ? value : fallback;
};

const readBoolean = (record: JsonRecord, fallback: boolean, ...keys: string[]): boolean => {
  const value = readValue(record, ...keys);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'si', 'sí'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
  }
  return fallback;
};

const normalizeBatchStatus = (value: string): ReviewBatchStatus => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'in_review' || normalized === 'publishing' || normalized === 'published'
    || normalized === 'publish_failed' || normalized === 'revoked') return normalized;
  return 'draft';
};

const normalizeItemStatus = (record: JsonRecord): ReviewItemStatus => {
  const value = readString(record, 'decision', 'reviewStatus', 'review_status', 'status').trim().toLowerCase();
  if (value === 'approved' || value === 'rejected' || value === 'superseded') return value;
  return 'pending';
};

const normalizePublicationStatus = (value: string): ReviewPublicationStatus => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'stored' || normalized === 'failed' || normalized === 'skipped') return normalized;
  return 'pending';
};

const normalizeSourceType = (value: string): ReviewSourceType => {
  const normalized = value.trim().toLowerCase().replaceAll('-', '_');
  if (normalized === 'editor_batch' || normalized === 'batch_sheets' || normalized === 'legacy') return normalized;
  if (normalized.includes('legacy')) return 'legacy';
  if (normalized.includes('sheet')) return 'batch_sheets';
  return 'editor_batch';
};

const normalizeSummary = (raw: unknown, items: CreativeReviewItem[] = []): ReviewSummary => {
  const record = asRecord(raw);
  const activeItems = items.filter((item) => item.status !== 'superseded');
  const fallback = items.length > 0 ? {
    total: activeItems.length,
    pending: activeItems.filter((item) => item.status === 'pending').length,
    approved: activeItems.filter((item) => item.status === 'approved').length,
    rejected: activeItems.filter((item) => item.status === 'rejected').length,
    superseded: items.filter((item) => item.status === 'superseded').length,
    stored: items.filter((item) => item.publicationStatus === 'stored').length,
    failed: items.filter((item) => item.publicationStatus === 'failed').length,
  } : EMPTY_SUMMARY;

  return {
    total: readNumber(record, fallback.total, 'total', 'itemCount', 'item_count'),
    pending: readNumber(record, fallback.pending, 'pending', 'pendingCount', 'pending_count'),
    approved: readNumber(record, fallback.approved, 'approved', 'approvedCount', 'approved_count'),
    rejected: readNumber(record, fallback.rejected, 'rejected', 'rejectedCount', 'rejected_count'),
    superseded: readNumber(record, fallback.superseded, 'superseded', 'supersededCount', 'superseded_count'),
    stored: readNumber(record, fallback.stored, 'stored', 'storedCount', 'stored_count', 'published'),
    failed: readNumber(record, fallback.failed, 'failed', 'failedCount', 'failed_count', 'publicationFailed'),
  };
};

export const normalizeReviewItem = (raw: unknown, index = 0): CreativeReviewItem => {
  const record = asRecord(raw);
  const id = readString(record, 'id', 'reviewItemId', 'review_item_id', 'itemId', 'item_id') || `item-${index}`;
  const familyId = readString(record, 'familyId', 'family_id', 'creativeFamilyId', 'creative_family_id') || id;
  return {
    id,
    batchId: readString(record, 'batchId', 'batch_id', 'reviewBatchId', 'review_batch_id'),
    familyId,
    version: readNumber(record, 1, 'version'),
    ratio: readString(record, 'ratio', 'aspectRatio', 'aspect_ratio') || 'Sin ratio',
    variant: readString(record, 'variant', 'variantName', 'variant_name') || 'Original',
    label: readString(record, 'label', 'name', 'title') || undefined,
    imageUrl: readString(record, 'imageUrl', 'image_url', 'driveUrl', 'drive_url', 'previewUrl', 'preview_url', 'generatedUrl', 'generated_url'),
    referenceUrl: readString(record, 'referenceUrl', 'reference_url', 'originalUrl', 'original_url', 'sourceImageUrl', 'source_image_url') || undefined,
    category: readString(record, 'category') || 'Sin categoría',
    plaza: readString(record, 'plaza', 'plazas') || 'Sin plaza',
    status: normalizeItemStatus(record),
    reason: readString(record, 'reason', 'feedback', 'rejectionReason', 'rejection_reason') || undefined,
    reviewerName: readString(record, 'reviewerName', 'reviewer_name') || undefined,
    reviewerEmail: readString(record, 'reviewerEmail', 'reviewer_email') || undefined,
    publicationStatus: normalizePublicationStatus(readString(record, 'publicationStatus', 'publication_status', 'publishStatus', 'publish_status')),
    publicationError: readString(record, 'publicationError', 'publication_error') || undefined,
    creativeId: readString(record, 'creativeId', 'creative_id') || undefined,
    sourceTab: readString(record, 'sourceTab', 'source_tab') || undefined,
    sourceRow: readString(record, 'sourceRow', 'source_row') || undefined,
    sourceCell: readString(record, 'sourceCell', 'source_cell') || undefined,
    createdAt: readString(record, 'createdAt', 'created_at') || undefined,
  };
};

export const normalizeReviewBatch = (raw: unknown, items: CreativeReviewItem[] = []): CreativeReviewBatch => {
  const record = asRecord(raw);
  const metadata = asRecord(readValue(record, 'metadata', 'metadata_json'));
  const summaryRaw = readValue(record, 'summary', 'totals', 'counts') ?? record;
  return {
    id: readString(record, 'id', 'batchId', 'batch_id', 'reviewBatchId', 'review_batch_id'),
    title: readString(record, 'title', 'name') || 'Tanda de creativos',
    sourceType: normalizeSourceType(readString(record, 'sourceType', 'source_type', 'origin')),
    status: normalizeBatchStatus(readString(record, 'status')),
    sheetsUrl: readString(record, 'sheetsUrl', 'sheets_url', 'spreadsheetUrl', 'spreadsheet_url'),
    sheetName: readString(record, 'sheetName', 'sheet_name', 'sourceTab', 'source_tab') || undefined,
    category: readString(record, 'category') || readString(metadata, 'category') || 'Sin categoría',
    plaza: readString(record, 'plaza', 'plazas') || readString(metadata, 'plaza', 'plazas') || 'Sin plaza',
    creatorName: readString(record, 'creatorName', 'creator_name', 'createdBy', 'created_by') || undefined,
    creatorEmail: readString(record, 'creatorEmail', 'creator_email') || undefined,
    reviewerName: readString(record, 'reviewerName', 'reviewer_name') || undefined,
    reviewerEmail: readString(record, 'reviewerEmail', 'reviewer_email') || undefined,
    privateUrl: readString(record, 'privateUrl', 'private_url', 'reviewUrl', 'review_url', 'shareUrl', 'share_url') || undefined,
    expiresAt: readString(record, 'expiresAt', 'expires_at') || undefined,
    createdAt: readString(record, 'createdAt', 'created_at') || undefined,
    updatedAt: readString(record, 'updatedAt', 'updated_at') || undefined,
    sentAt: readString(record, 'sentAt', 'sent_at', 'issuedAt', 'issued_at') || undefined,
    completedAt: readString(record, 'completedAt', 'completed_at', 'finalizedAt', 'finalized_at', 'publishedAt', 'published_at') || undefined,
    summary: normalizeSummary(summaryRaw, items),
  };
};

const parseErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = asRecord(await response.json());
    const details = asRecord(payload.details);
    return readString(payload, 'error', 'message')
      || readString(details, 'message')
      || `La solicitud falló con estado ${response.status}.`;
  } catch {
    return `La solicitud falló con estado ${response.status}.`;
  }
};

const requestJson = async <T = unknown>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) throw new Error(await parseErrorMessage(response));
  if (response.status === 204) return {} as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
};

const jsonBody = (body: unknown): Pick<RequestInit, 'headers' | 'body'> => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const normalizeReviewPayload = (raw: unknown): CreativeReviewPayload => {
  const record = asRecord(raw);
  const rawBatch = readValue(record, 'batch', 'reviewBatch', 'review_batch') ?? record;
  const batchRecord = asRecord(rawBatch);
  const rawItems = readValue(record, 'items', 'reviewItems', 'review_items')
    ?? readValue(batchRecord, 'items', 'reviewItems', 'review_items');
  const items = Array.isArray(rawItems) ? rawItems.map(normalizeReviewItem) : [];
  const rawSummary = readValue(record, 'summary', 'totals', 'counts')
    ?? readValue(batchRecord, 'summary', 'totals', 'counts');
  const summary = normalizeSummary(rawSummary, items);
  const batch = normalizeReviewBatch(rawBatch, items);
  return { batch: { ...batch, summary }, items, summary };
};

const normalizeBatchAction = (raw: unknown): BatchActionResponse => {
  const record = asRecord(raw);
  const rawBatch = readValue(record, 'batch', 'reviewBatch', 'review_batch');
  const privateUrl = readString(record, 'privateUrl', 'private_url', 'reviewUrl', 'review_url', 'shareUrl', 'share_url')
    || (rawBatch ? normalizeReviewBatch(rawBatch).privateUrl : '');
  return {
    batch: rawBatch ? normalizeReviewBatch(rawBatch) : undefined,
    privateUrl: privateUrl || undefined,
  };
};

export const exchangeReviewSession = async (token: string): Promise<void> => {
  await requestJson('/api/creative-reviews/session', {
    method: 'POST',
    ...jsonBody({ token }),
  });
};

export const fetchPublicReview = async (): Promise<CreativeReviewPayload> =>
  normalizeReviewPayload(await requestJson('/api/creative-reviews/public'));

export const updatePublicDecisions = async (decisions: ReviewDecisionInput[]): Promise<CreativeReviewPayload> =>
  normalizeReviewPayload(await requestJson('/api/creative-reviews/public/decisions', {
    method: 'PATCH',
    ...jsonBody({ decisions }),
  }));

export const finalizePublicReview = async (input: FinalizeReviewInput): Promise<CreativeReviewPayload> =>
  normalizeReviewPayload(await requestJson('/api/creative-reviews/public/finalize', {
    method: 'POST',
    ...jsonBody(input),
  }));

export const fetchReviewBatches = async (sheetsUrl: string): Promise<CreativeReviewBatch[]> => {
  const params = new URLSearchParams({ sheetsUrl });
  const raw = await requestJson<unknown>(`/api/creative-reviews/batches?${params.toString()}`);
  const record = asRecord(raw);
  const batches = Array.isArray(raw) ? raw : readValue(record, 'batches', 'reviewBatches', 'review_batches');
  return Array.isArray(batches) ? batches.map((batch) => normalizeReviewBatch(batch)) : [];
};

export const fetchReviewBatch = async (
  batchId: string,
  sheetsUrl: string,
): Promise<CreativeReviewPayload> => {
  const params = new URLSearchParams({ sheetsUrl });
  return normalizeReviewPayload(await requestJson(
    `/api/creative-reviews/batches/${encodeURIComponent(batchId)}?${params.toString()}`,
  ));
};

export const updateReviewBatchDecisions = async (
  batchId: string,
  sheetsUrl: string,
  decisions: ReviewDecisionInput[],
): Promise<CreativeReviewPayload> => normalizeReviewPayload(
  await requestJson(`/api/creative-reviews/batches/${encodeURIComponent(batchId)}/decisions`, {
    method: 'PATCH',
    ...jsonBody({ sheetsUrl, decisions }),
  }),
);

export const finalizeReviewBatch = async (
  batchId: string,
  sheetsUrl: string,
  input: FinalizeReviewInput,
): Promise<CreativeReviewPayload> => normalizeReviewPayload(
  await requestJson(`/api/creative-reviews/batches/${encodeURIComponent(batchId)}/finalize`, {
    method: 'POST',
    ...jsonBody({ sheetsUrl, ...input }),
  }),
);

export const createReviewBatch = async (input: CreateReviewBatchInput): Promise<CreativeReviewBatch> => {
  const raw = await requestJson('/api/creative-reviews/batches', {
    method: 'POST',
    ...jsonBody(input),
  });
  const record = asRecord(raw);
  return normalizeReviewBatch(readValue(record, 'batch', 'reviewBatch', 'review_batch') ?? record);
};

const normalizeLegacyImportResponse = (raw: unknown): ImportLegacyReviewResponse => {
  const record = asRecord(raw);
  const rawBatch = readValue(record, 'batch', 'reviewBatch', 'review_batch') ?? record;
  const rawItems = readValue(record, 'items', 'reviewItems', 'review_items');
  const items = Array.isArray(rawItems) ? rawItems.map(normalizeReviewItem) : [];
  const summary = normalizeSummary(readValue(record, 'summary', 'totals', 'counts'), items);
  const rawBackup = asRecord(readValue(record, 'backup', 'backupFile', 'backup_file'));
  const backup: LegacyImportBackup | undefined = Object.keys(rawBackup).length > 0 ? {
    fileId: readString(rawBackup, 'fileId', 'file_id', 'id') || undefined,
    name: readString(rawBackup, 'name', 'title') || undefined,
    url: readString(rawBackup, 'url', 'webViewLink', 'web_view_link') || undefined,
  } : undefined;
  const rawWarnings = readValue(record, 'warnings');
  const warnings: LegacyImportWarning[] = Array.isArray(rawWarnings)
    ? rawWarnings.map((warning) => {
      const warningRecord = asRecord(warning);
      return {
        code: readString(warningRecord, 'code') || undefined,
        message: readString(warningRecord, 'message', 'error') || String(warning),
      };
    }).filter((warning) => warning.message)
    : [];

  return {
    batch: { ...normalizeReviewBatch(rawBatch, items), summary },
    items,
    summary,
    importedCount: readNumber(record, items.length, 'importedCount', 'imported_count'),
    existingLibraryMatches: readNumber(record, 0, 'existingLibraryMatches', 'existing_library_matches'),
    alreadyImported: readBoolean(record, false, 'alreadyImported', 'already_imported'),
    backup,
    warnings,
  };
};

export const importLegacyReviewBatch = async (
  input: ImportLegacyReviewInput,
): Promise<ImportLegacyReviewResponse> => normalizeLegacyImportResponse(
  await requestJson('/api/creative-reviews/import-legacy', {
    method: 'POST',
    ...jsonBody(input),
  }),
);

const runBatchAction = async (
  batchId: string,
  sheetsUrl: string,
  action: 'send' | 'revoke' | 'retry',
): Promise<BatchActionResponse> =>
  normalizeBatchAction(await requestJson(`/api/creative-reviews/batches/${encodeURIComponent(batchId)}/${action}`, {
    method: 'POST',
    ...jsonBody({ sheetsUrl }),
  }));

export const sendReviewBatch = (batchId: string, sheetsUrl: string) => runBatchAction(batchId, sheetsUrl, 'send');
export const revokeReviewBatch = (batchId: string, sheetsUrl: string) => runBatchAction(batchId, sheetsUrl, 'revoke');
export const retryReviewBatchPublication = (batchId: string, sheetsUrl: string) => runBatchAction(batchId, sheetsUrl, 'retry');
