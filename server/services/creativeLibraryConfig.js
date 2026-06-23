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
export const CREATIVE_CATEGORIES_SHEET = 'creative_categories';

export const CREATIVE_CATEGORIES_HEADERS = [
  'category',
  'keywords',
  'active',
  'notes',
];

export const SOURCE_STATUS_COLUMNS = [
  'category',
  'plazas',
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
  'used_at',
  'google_ads_asset_resource_name',
  'replacement_operation_id',
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
});
