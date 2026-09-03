export const DEFAULT_CATEGORIES = [
  'Generic',
  'Promo',
  'Alianzas',
];

export const DEFAULT_PLAZAS = [
  'ALL',
  'BUE',
  'ATE',
  'CBA',
  'CPZ',
  'RCU',
  'MDZ',
  'ROS',
  'CTE',
  'RES',
  'LUJ',
  'TUC',
  'NQN',
  'BRC',
  'MVD',
  'CAN',
  'MAL',
  'MDQ',
];

export const DEFAULT_SOURCE_SHEETS = [
  'Riders | AR',
];

export const CREATIVE_LIBRARY_SHEET = 'creative_library';
export const CREATIVE_AUDIT_SHEET = 'creative_audit_log';
export const CREATIVE_CAMPAIGN_USAGE_SHEET = 'creative_campaign_usage';
export const GOOGLE_ASSET_CACHE_SHEET = 'google_asset_cache';
export const CREATIVE_CATEGORIES_SHEET = 'creative_categories';
export const CREATIVE_REVIEW_BATCHES_SHEET = 'creative_review_batches';
export const CREATIVE_REVIEW_ITEMS_SHEET = 'creative_review_items';
export const CREATIVE_RUNS_SHEET = 'creative_runs';
export const CREATIVE_RUN_TARGETS_SHEET = 'creative_run_targets';
export const BATCH_VARIATIONS_SHEET = 'batch_variations';

/**
 * One row per variation produced by Batch from Sheets. This is where the batch
 * writes its output: the source tab is read-only, so no operator has to
 * pre-build ratio columns and nothing in their sheet gets overwritten.
 *
 * `review_item_id` is the link into `creative_review_items`, and
 * `creative_review_url` gives operators a direct way back into the review UI.
 * Together they trace a row through review, approval and publication.
 * Append-only, like the review tabs — a re-run adds a batch, it never rewrites
 * history.
 */
export const BATCH_VARIATION_HEADERS = [
  'variation_id',
  'review_batch_id',
  'review_item_id',
  'creative_review_url',
  'creative_family_id',
  'batch_title',
  'source_sheet_id',
  'source_tab',
  'source_row',
  'source_image_url',
  'aspect_ratio',
  'variant',
  'image_url',
  'drive_file_id',
  'category',
  'plazas',
  'status',
  'error',
  'created_at',
];

/**
 * One row per funnel run (ciclo). The run is the entity that spans all five
 * steps: detection, generation, internal review, client approval and placement.
 */
export const CREATIVE_RUN_HEADERS = [
  'run_id',
  'status',
  'title',
  'created_by',
  'created_at',
  'updated_at',
  'platform',
  'account_id',
  'campaign_ids',
  'category',
  'plazas',
  'source_sheet_id',
  'review_batch_id',
  'private_url',
  'sent_at',
  'target_count',
  'generated_count',
  'approved_count',
  'replaced_count',
  'error',
  'version',
  'metadata_json',
];

/**
 * One row per detected low performer. This is the table that links a failing
 * creative (step 1) to the pieces generated to replace it (step 2), the review
 * items they became (steps 3-4) and the creative that finally shipped (step 5).
 */
export const CREATIVE_RUN_TARGET_HEADERS = [
  'run_id',
  'target_id',
  'status',
  'platform',
  'account_id',
  'campaign_id',
  'campaign_name',
  'ad_group_id',
  'ad_group_name',
  'ad_id',
  'asset_id',
  'asset_resource_name',
  'old_image_url',
  'required_ratio',
  'detected_category',
  'detected_plazas',
  'source_image_origin',
  'source_image_url',
  'creative_family_id',
  'review_item_ids',
  'creative_id',
  'error',
  'created_at',
  'updated_at',
  'metrics_json',
];

export const CREATIVE_REVIEW_BATCH_HEADERS = [
  'review_batch_id',
  'source_type',
  'status',
  'title',
  'context',
  'created_by',
  'created_at',
  'updated_at',
  'issued_at',
  'expires_at',
  'token_hash',
  'revoked_at',
  'reviewer_name',
  'reviewer_email',
  'review_started_at',
  'finalized_at',
  'published_at',
  'source_sheet_id',
  'source_tab',
  'version',
  'item_count',
  'approved_count',
  'rejected_count',
  'pending_count',
  'publish_error',
  'metadata_json',
];

export const CREATIVE_REVIEW_ITEM_HEADERS = [
  'review_item_id',
  'review_batch_id',
  'creative_family_id',
  'creative_version',
  'generation_id',
  'version',
  'aspect_ratio',
  'variant',
  'reference_url',
  'image_url',
  'drive_file_id',
  'image_hash',
  'category',
  'plazas',
  'decision',
  'feedback',
  'reviewer_name',
  'reviewer_email',
  'decided_at',
  'publication_status',
  'creative_id',
  'publication_error',
  'published_at',
  'source_sheet_id',
  'source_tab',
  'source_row',
  'source_cell',
  'source_output',
  'created_at',
  'updated_at',
  'superseded_at',
  'metadata_json',
];

export const CREATIVE_CATEGORIES_HEADERS = [
  'category',
  'keywords',
  'active',
  'notes',
];

export const SOURCE_STATUS_COLUMNS = [
  'category',
  'plazas',
  'creative_family_id',
  'storage_status',
  'creative_ids',
  'google_ads_status',
  'notes',
];

export const CREATIVE_LIBRARY_HEADERS = [
  'creative_id',
  'status',
  'category',
  'plazas',
  'creative_family_id',
  'source_sheet_id',
  'source_tab',
  'source_row',
  'source_cell',
  'resized_image_url',
  'drive_file_id',
  'drive_url',
  'aspect_ratio',
  'image_resolution',
  'image_hash',
  'created_at',
  'reserved_at',
  'used_at_google',
  'used_at_meta',
  'ads_platform',
  'ads_resource_name',
  'google_ads_asset_resource_name',
  'replacement_operation_id',
  'review_batch_id',
  'review_item_id',
  'notes',
];

export const CREATIVE_AUDIT_HEADERS = [
  'timestamp',
  'event',
  'creative_id',
  'category',
  'customer_id',
  'campaign_id',
  'ad_group_id',
  'asset_group_id',
  'old_asset_resource_name',
  'new_asset_resource_name',
  'status',
  'message',
  'payload_json',
];

export const CREATIVE_CAMPAIGN_USAGE_HEADERS = [
  'creative_id',
  'platform',
  'account_id',
  'campaign_id',
  'campaign_name',
  'operation_id',
  'status',
  'ads_resource_name',
  'reserved_at',
  'used_at',
  'updated_at',
];

export const GOOGLE_ASSET_CACHE_HEADERS = [
  'customer_id',
  'creative_hash',
  'asset_resource_name',
  'status',
  'created_at',
  'updated_at',
];

const parseJsonEnv = (key, fallback) => {
  const raw = process.env[key];
  if (!raw?.trim()) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const parseListEnv = (key, fallback) => {
  const raw = process.env[key];
  if (!raw?.trim()) return fallback;

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
};

const parseNumberEnv = (key, fallback) => {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getCreativeLibraryConfig = () => ({
  categories: parseListEnv('CREATIVE_LIBRARY_CATEGORIES', DEFAULT_CATEGORIES),
  plazas: parseListEnv('CREATIVE_LIBRARY_PLAZAS', DEFAULT_PLAZAS),
  sourceSheets: parseListEnv('CREATIVE_LIBRARY_SOURCE_SHEETS', DEFAULT_SOURCE_SHEETS),
  acceptedColor: process.env.CREATIVE_ACCEPTED_COLOR || '#00ff00',
  rejectedColor: process.env.CREATIVE_REJECTED_COLOR || '#ff0000',
  colorTolerance: parseNumberEnv('CREATIVE_COLOR_TOLERANCE', 170),
  driveRootFolderId:
    process.env.CREATIVE_LIBRARY_DRIVE_FOLDER_ID ||
    process.env.BATCH_DRIVE_FOLDER_ID ||
    '0APcMUrimfyziUk9PVA',
  sourceBankFolderId: process.env.CREATIVE_SOURCE_BANK_FOLDER_ID || '',
  preferGooglePhotosForBatch: process.env.BATCH_USE_GOOGLE_PHOTOS === '1',
  dryRunDefault: process.env.REPLACEMENT_DRY_RUN_DEFAULT !== '0',
  selectionStrategy: process.env.CREATIVE_SELECTION_STRATEGY || 'oldest_first',
  maxDownloadSizeBytes: parseNumberEnv('CREATIVE_LIBRARY_MAX_IMAGE_BYTES', 50 * 1024 * 1024),
  categoryMapping: parseJsonEnv('CREATIVE_CATEGORY_MAPPING', {
    generic: ['generic', 'general', 'always on', 'always-on', 'alwayson', 'brand', 'marca'],
    promo: ['promo', 'promos', 'promocion', 'promoción', 'promotion', 'discount', 'descuento', 'offer', 'oferta', 'beneficio', 'beneficios'],
    alianzas: ['alianza', 'alianzas', 'partner', 'partners', 'partnership', 'aliado', 'aliados', 'co-brand', 'cobrand', 'cobranding'],
  }),
  googleLowPerformanceLabel: process.env.GOOGLE_LOW_PERFORMANCE_LABEL || 'LOW',
  reviewSheetsUrl:
    process.env.CREATIVE_REVIEW_SHEETS_URL ||
    process.env.CREATIVE_LIBRARY_SHEETS_URL ||
    process.env.DEFAULT_SHEETS_URL ||
    '',
  reviewBaseUrl:
    process.env.CREATIVE_REVIEW_PUBLIC_BASE_URL ||
    process.env.CREATIVE_REVIEW_BASE_URL ||
    process.env.APP_BASE_URL ||
    '',
  reviewLinkDays: parseNumberEnv(
    'CREATIVE_REVIEW_TOKEN_TTL_DAYS',
    parseNumberEnv('CREATIVE_REVIEW_LINK_DAYS', 30),
  ),
});
