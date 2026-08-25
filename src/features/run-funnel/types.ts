import type { AdsPlatform, ExecutionResponse, ReplacementPlanResponse } from '../creative-library/types';

export type RunStatus =
  | 'draft'
  | 'detecting'
  | 'generating'
  | 'internal_review'
  | 'awaiting_client'
  | 'client_review'
  | 'placement'
  | 'completed'
  | 'failed';

export type RunTargetStatus =
  | 'detected'
  | 'generating'
  | 'generated'
  | 'no_source'
  | 'failed'
  | 'approved'
  | 'replaced';

export interface RunTargetSummary {
  total: number;
  detected: number;
  generating: number;
  generated: number;
  no_source: number;
  failed: number;
  approved: number;
  replaced: number;
  pendingGeneration: number;
}

export interface CreativeRun {
  id: string;
  status: RunStatus;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  platform: AdsPlatform | '';
  accountId: string;
  campaignIds: string[];
  category: string;
  plazas: string[];
  sheetsUrl: string;
  reviewBatchId: string;
  privateUrl: string;
  sentAt: string;
  targetCount: number;
  generatedCount: number;
  approvedCount: number;
  replacedCount: number;
  error: string;
  version: number;
  metadata: Record<string, unknown>;
  summary: RunTargetSummary;
}

export interface RunTarget {
  runId: string;
  targetId: string;
  status: RunTargetStatus;
  platform: string;
  accountId: string;
  campaignId: string;
  campaignName: string;
  adGroupId: string;
  adGroupName: string;
  adId: string;
  assetId: string;
  assetResourceName: string;
  oldImageUrl: string;
  requiredRatio: string;
  detectedCategory: string;
  detectedPlazas: string[];
  sourceImageOrigin: string;
  sourceImageUrl: string;
  creativeFamilyId: string;
  reviewItemIds: string[];
  creativeId: string;
  error: string;
  createdAt: string;
  updatedAt: string;
  metrics: {
    impressions?: number;
    clicks?: number;
    ctr?: number;
    conversions?: number;
    conversionRate?: number;
    cost?: number;
    cpa?: number;
    reason?: string;
    adName?: string;
    adType?: string;
    supportedReplacement?: boolean;
  };
}

export interface RunDetail {
  run: CreativeRun;
  targets: RunTarget[];
}

export interface CreateRunInput {
  sheetsUrl?: string;
  title: string;
  createdBy: string;
  platform: AdsPlatform;
  accountId: string;
  campaignIds: string[];
  category: string;
  plazas: string[];
  analysisDays?: number;
  minImpressions?: number;
  maxAssetsPerAd?: number;
  limit?: number;
}

export interface RunGenerationEvent {
  state:
    | 'started'
    | 'keepalive'
    | 'target_started'
    | 'target_done'
    | 'target_failed'
    | 'target_skipped'
    | 'ratio_done'
    | 'ratio_failed'
    | 'completed'
    | 'done'
    | 'error';
  runId?: string;
  batchId?: string;
  targetId?: string;
  ratio?: string;
  variants?: number;
  index?: number;
  pending?: number;
  total?: number;
  skipped?: number;
  reason?: string;
  error?: string;
  run?: CreativeRun;
  targets?: RunTarget[];
  summary?: RunTargetSummary;
}

export interface SubmitReviewResponse {
  run: CreativeRun;
  privateUrl: string;
  expiresAt: string;
}

export interface SyncRunResponse extends RunDetail {
  reviewStatus: string;
  summary: RunTargetSummary;
}

export type RunPlanResponse = ReplacementPlanResponse & { run: CreativeRun };
export type RunExecutionResponse = ExecutionResponse & { run: CreativeRun };
