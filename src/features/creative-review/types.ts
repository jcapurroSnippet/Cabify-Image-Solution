export type ReviewSourceType = 'editor_batch' | 'batch_sheets' | 'legacy';

export type ReviewBatchStatus =
  | 'draft'
  | 'in_review'
  | 'publishing'
  | 'published'
  | 'publish_failed'
  | 'revoked';

export type ReviewItemStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

export type ReviewPublicationStatus = 'pending' | 'stored' | 'failed' | 'skipped';

export interface ReviewSummary {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  superseded: number;
  stored: number;
  failed: number;
}

export interface CreativeReviewBatch {
  id: string;
  title: string;
  sourceType: ReviewSourceType;
  status: ReviewBatchStatus;
  sheetsUrl: string;
  sheetName?: string;
  category: string;
  plaza: string;
  creatorName?: string;
  creatorEmail?: string;
  reviewerName?: string;
  reviewerEmail?: string;
  privateUrl?: string;
  expiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
  sentAt?: string;
  completedAt?: string;
  summary: ReviewSummary;
}

export interface CreativeReviewItem {
  id: string;
  batchId: string;
  familyId: string;
  version: number;
  ratio: string;
  variant: string;
  label?: string;
  imageUrl: string;
  referenceUrl?: string;
  category: string;
  plaza: string;
  status: ReviewItemStatus;
  reason?: string;
  reviewerName?: string;
  reviewerEmail?: string;
  publicationStatus: ReviewPublicationStatus;
  publicationError?: string;
  creativeId?: string;
  sourceTab?: string;
  sourceRow?: string;
  sourceCell?: string;
  createdAt?: string;
}

export interface CreativeReviewPayload {
  batch: CreativeReviewBatch;
  items: CreativeReviewItem[];
  summary: ReviewSummary;
}

export interface CreateReviewBatchInput {
  title: string;
  sourceType: Exclude<ReviewSourceType, 'legacy'>;
  sheetsUrl: string;
  category: string;
  plazas: string;
}

export interface ReviewDecisionInput {
  reviewItemId: string;
  version: number;
  status: Extract<ReviewItemStatus, 'approved' | 'rejected'>;
  reason: string;
}

export interface FinalizeReviewInput {
  reviewerName: string;
  reviewerEmail: string;
}

export interface BatchActionResponse {
  batch?: CreativeReviewBatch;
  privateUrl?: string;
}

export interface LegacyImportWarning {
  code?: string;
  message: string;
}

export interface LegacyImportBackup {
  fileId?: string;
  name?: string;
  url?: string;
}

export interface ImportLegacyReviewInput {
  sheetsUrl: string;
  sheetName: string;
  title?: string;
}

export interface ImportLegacyReviewResponse {
  batch: CreativeReviewBatch;
  items: CreativeReviewItem[];
  summary: ReviewSummary;
  importedCount: number;
  existingLibraryMatches: number;
  alreadyImported: boolean;
  backup?: LegacyImportBackup;
  warnings: LegacyImportWarning[];
}
