export interface AccountOption {
  id: string;
  label: string;
}

export interface CampaignOption {
  id: string;
  label: string;
}

export interface CreativeLibraryItem {
  creative_id: string;
  status: string;
  category: string;
  plazas: string;
  source_tab: string;
  source_row: string;
  source_cell: string;
  drive_url: string;
  created_at: string;
  used_at: string;
  replacement_operation_id: string;
}

export interface CreativeLibrarySummary {
  total: number;
  byCategory: Record<string, Record<string, number>>;
  byStatus: Record<string, number>;
}

export interface CreativeLibraryResponse {
  spreadsheetId: string;
  categories?: string[];
  creatives: CreativeLibraryItem[];
  summary: CreativeLibrarySummary;
}

export interface SyncResponse {
  spreadsheetId: string;
  sheetName: string;
  totals: Record<string, number>;
  debugLogPath?: string;
  failureDetails?: Array<{
    sheetName: string;
    rowNumber: number;
    sourceCell: string;
    category: string;
    plazas?: string;
    resizedImageUrl?: string;
    error: string;
    details?: {
      message?: string;
      status?: string | number | null;
      data?: unknown;
    };
  }>;
  rows: Array<{
    rowNumber: number;
    status: string;
    creativeIds: string[];
    counts: Record<string, number>;
    notes: string[];
  }>;
}

export interface LowPerformer {
  id: string;
  customerId: string;
  campaignId: string;
  campaignName: string;
  adGroupId: string;
  adGroupName: string;
  assetId: string;
  assetResourceName: string;
  assetGroupName?: string;
  adId?: string;
  adType?: string;
  adResourceName?: string;
  assetName: string;
  assetUrl: string;
  imageWidth: number;
  imageHeight: number;
  imageResolution: string;
  targetType?: string;
  associationResourceName?: string;
  assetFieldType?: string;
  replacementStrategy?: string;
  googleAdsUrl: string;
  detectedCategory?: string | null;
  detectedPlazas?: string | null;
  categorySource?: string;
  categoryWarning?: string | null;
  matchedCategories?: string[];
  performanceLabel?: string;
  reason: string;
  supportedReplacement: boolean;
  metrics: {
    impressions: number;
    clicks: number;
    ctr: number;
    conversions: number;
    conversionRate: number;
    cost: number;
  };
}

export interface ReplacementOperation {
  id: string;
  status: string;
  executionStatus?: string;
  message: string;
  executionMessage?: string;
  campaignName: string;
  adGroupName: string;
  assetGroupName?: string;
  adId?: string;
  adType?: string;
  targetType?: string;
  assetFieldType?: string;
  replacementStrategy?: string;
  associationResourceName?: string;
  reason: string;
  detectedCategory: string | null;
  detectedPlazas?: string | null;
  categorySource?: string;
  supportedReplacement: boolean;
  oldAssetUrl: string;
  oldAssetId?: string;
  oldAssetResourceName?: string;
  oldImageResolution?: string;
  googleAdsUrl?: string;
  creative: {
    creative_id: string;
    category: string;
    plazas?: string;
    drive_url: string;
    created_at: string;
  } | null;
  metrics: LowPerformer['metrics'];
}

export interface ReplacementPlanResponse {
  dryRun: boolean;
  summary: Record<string, number>;
  operations: ReplacementOperation[];
  librarySummary?: CreativeLibrarySummary;
}

export interface ExecutionResponse {
  dryRun: boolean;
  summary: Record<string, number>;
  results: ReplacementOperation[];
}
