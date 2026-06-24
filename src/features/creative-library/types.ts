export interface AccountOption {
  id: string;
  label: string;
}

export interface CampaignOption {
  id: string;
  label: string;
}

export type AdsPlatform = 'google' | 'meta';
export type LowPerformerSource = AdsPlatform | 'both';

export interface AdsSelection {
  accountId: string;
  campaignIds: string[];
}

export type AdsSelections = Partial<Record<AdsPlatform, AdsSelection>>;

export interface CreativeLibraryItem {
  creative_id: string;
  status: string;
  category: string;
  plazas: string;
  source_tab: string;
  source_row: string;
  source_cell: string;
  drive_url: string;
  aspect_ratio?: string;
  image_resolution?: string;
  created_at: string;
  used_at: string;
  ads_platform?: string;
  ads_resource_name?: string;
  google_ads_asset_resource_name?: string;
  replacement_operation_id: string;
}

export interface CreativeLibrarySummary {
  total: number;
  byCategory: Record<string, Record<string, number>>;
  byStatus: Record<string, number>;
}

export type ReplacementMode = 'strict_same_ad' | 'allow_google_required_clone';

export interface AdsTraceEntry {
  timestamp?: string;
  step?: string;
  status?: string;
  [key: string]: unknown;
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
  platform?: AdsPlatform;
  platformLabel?: string;
  accountId?: string;
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
  adsUrl?: string;
  detectedCategory?: string | null;
  detectedPlazas?: string | null;
  categorySource?: string;
  categoryWarning?: string | null;
  matchedCategories?: string[];
  performanceLabel?: string;
  reason: string;
  supportedReplacement: boolean;
  replacementSupportReason?: string | null;
  replacementSupportMessage?: string | null;
  metrics: {
    impressions: number;
    clicks: number;
    ctr: number;
    conversions: number;
    conversionRate: number;
    cost: number;
    cpa?: number;
  };
}

export interface ReplacementOperation {
  id: string;
  platform?: AdsPlatform;
  platformLabel?: string;
  accountId?: string;
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
  replacementMode?: ReplacementMode;
  canPreserveAdId?: boolean;
  canPreserveServingContainer?: boolean;
  requiresNewAd?: boolean;
  executableInMode?: boolean;
  executionPolicy?: string;
  blockedReason?: string | null;
  blockedMessage?: string | null;
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
  requiredAspectRatio?: string | null;
  googleAdsUrl?: string;
  adsUrl?: string;
  creative: {
    creative_id: string;
    category: string;
    plazas?: string;
    drive_url: string;
    aspect_ratio?: string;
    image_resolution?: string;
    created_at: string;
  } | null;
  replacementImageResolution?: string;
  replacementAspectRatio?: string | null;
  metrics: LowPerformer['metrics'];
}

export interface ReplacementPlanResponse {
  dryRun: boolean;
  source?: LowPerformerSource;
  replacementMode?: ReplacementMode;
  summary: Record<string, number>;
  operations: ReplacementOperation[];
  librarySummary?: CreativeLibrarySummary;
}

export interface ExecutionResponse {
  dryRun: boolean;
  source?: LowPerformerSource;
  replacementMode?: ReplacementMode;
  summary: Record<string, number>;
  googleAdsTrace?: AdsTraceEntry[];
  metaAdsTrace?: AdsTraceEntry[];
  results: ReplacementOperation[];
}
