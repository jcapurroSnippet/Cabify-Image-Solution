import crypto from 'node:crypto';

export const normalizeCategory = (value, categories) => {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;

  const matchedCategory = categories.find((category) => String(category).toLowerCase() === text);
  return matchedCategory || null;
};

export const normalizeHeader = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

export const extractUrlFromFormula = (formula) => {
  if (typeof formula !== 'string') return null;
  const match = formula.match(/HYPERLINK\(\s*["']([^"']+)["']/i);
  return match ? match[1] : null;
};

export const normalizeUrl = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  if (/^https?:\/\//i.test(text)) return text;
  if (/^(drive|docs)\.google\.com\//i.test(text) || /^www\./i.test(text)) return `https://${text}`;

  const httpMatch = text.match(/https?:\/\/\S+/i);
  if (httpMatch) return httpMatch[0].replace(/[),.]+$/g, '');

  const googleMatch = text.match(/(?:drive|docs)\.google\.com\/\S+/i);
  if (googleMatch) return `https://${googleMatch[0].replace(/[),.]+$/g, '')}`;

  return null;
};

export const getCellText = (cell) => {
  if (!cell) return '';
  const value = cell.userEnteredValue;
  if (value?.stringValue !== undefined) return String(value.stringValue);
  if (value?.numberValue !== undefined) return String(value.numberValue);
  if (value?.boolValue !== undefined) return String(value.boolValue);
  return cell.formattedValue || '';
};

export const getCellUrl = (cell) => {
  if (!cell) return null;
  if (cell.hyperlink) return cell.hyperlink;

  const formulaUrl = extractUrlFromFormula(cell.userEnteredValue?.formulaValue);
  if (formulaUrl) return formulaUrl;

  const runUrl = cell.textFormatRuns?.find((run) => run?.format?.link?.uri)?.format?.link?.uri;
  if (runUrl) return runUrl;

  return normalizeUrl(getCellText(cell));
};

const hexToRgb = (hex) => {
  const clean = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-f]{6}$/i.test(clean)) return null;

  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
};

export const googleColorToRgb = (color) => {
  if (!color || typeof color !== 'object') return null;
  return {
    r: Math.round((color.red ?? 0) * 255),
    g: Math.round((color.green ?? 0) * 255),
    b: Math.round((color.blue ?? 0) * 255),
  };
};

const colorDistance = (left, right) => {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  return Math.sqrt(
    (left.r - right.r) ** 2 +
      (left.g - right.g) ** 2 +
      (left.b - right.b) ** 2,
  );
};

export const classifyBackgroundColor = (cell, config) => {
  const rgb = googleColorToRgb(
    cell?.effectiveFormat?.backgroundColor || cell?.userEnteredFormat?.backgroundColor,
  );

  if (!rgb) return 'PENDING';

  const accepted = hexToRgb(config.acceptedColor);
  const rejected = hexToRgb(config.rejectedColor);
  const acceptedDistance = colorDistance(rgb, accepted);
  const rejectedDistance = colorDistance(rgb, rejected);

  if (
    acceptedDistance <= config.colorTolerance ||
    (rgb.g > 105 && rgb.g - rgb.r > 45 && rgb.g - rgb.b > 35) ||
    (rgb.g >= 220 && rgb.r >= 180 && rgb.b >= 180 && rgb.g - rgb.r >= 10 && rgb.g - rgb.b >= 10)
  ) {
    return 'ACCEPTED';
  }

  if (
    rejectedDistance <= config.colorTolerance ||
    (rgb.r > 125 && rgb.r - rgb.g > 45 && rgb.r - rgb.b > 35) ||
    (rgb.r >= 230 && rgb.g >= 170 && rgb.b >= 170 && rgb.r - rgb.g >= 20 && rgb.r - rgb.b >= 20)
  ) {
    return 'REJECTED';
  }

  if (rgb.r > 240 && rgb.g > 240 && rgb.b > 240) return 'PENDING';
  return 'UNKNOWN_COLOR';
};

export const hashBuffer = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

export const dataUrlToBuffer = (dataUrl) => {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid data URL.');
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
};

export const sanitizeFileName = (value) => {
  const clean = String(value || 'creative')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_.-]/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 120);

  return clean || 'creative';
};

const normalizeComparableText = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const normalizePlazaCode = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();

const getConfiguredPlazas = (config = {}) =>
  (Array.isArray(config.plazas) ? config.plazas : [])
    .map(normalizePlazaCode)
    .filter(Boolean);

export const normalizePlazas = (value) => {
  const seen = new Set();
  const plazas = [];

  for (const token of String(value ?? '').match(/[a-z0-9]+/gi) || []) {
    const plaza = normalizePlazaCode(token);
    if (!plaza || seen.has(plaza)) continue;
    seen.add(plaza);
    plazas.push(plaza);
  }

  return plazas.join(', ');
};

const inferPlazaCodes = (name, config) => {
  const configuredPlazas = getConfiguredPlazas(config);
  const allowed = new Set(configuredPlazas);
  const seen = new Set();
  const plazas = [];

  for (const token of String(name || '').match(/[a-z0-9]+/gi) || []) {
    const plaza = normalizePlazaCode(token);
    if (!allowed.has(plaza) || seen.has(plaza)) continue;
    seen.add(plaza);
    plazas.push(plaza);
  }

  return plazas;
};

export const detectPlazasFromName = (name, config = {}) => {
  const text = String(name || '').trim();
  if (!text) {
    return { plazas: '', matched: [], warning: null };
  }

  const matched = inferPlazaCodes(text, config);
  return {
    plazas: matched.join(', '),
    matched,
    warning: matched.length === 0 ? 'PLAZAS_NOT_FOUND' : null,
  };
};

export const detectCategoryFromName = (name, config) => {
  const text = String(name || '').toLowerCase();
  if (!text.trim()) {
    return { category: null, matched: [], warning: null };
  }

  const matched = [];
  for (const category of config.categories) {
    const categoryKey = String(category).toLowerCase();
    const keywords = config.categoryMapping[category] || config.categoryMapping[categoryKey] || [category];
    const hasMatch = keywords.some((keyword) => {
      const normalizedKeyword = String(keyword).toLowerCase().trim();
      if (!normalizedKeyword) return false;
      if (!/[a-z0-9]/i.test(normalizedKeyword)) return text.includes(normalizedKeyword);

      const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
    });

    if (hasMatch) matched.push(category);
  }

  if (matched.length === 0) {
    return { category: null, matched, warning: 'CATEGORY_NOT_FOUND' };
  }

  return {
    category: matched[0],
    matched,
    warning: matched.length > 1 ? 'MULTIPLE_CATEGORIES_MATCHED' : null,
  };
};

export const isLowPerforming = (metrics, rules) => {
  const impressions = Number(metrics?.impressions ?? 0);
  const clicks = Number(metrics?.clicks ?? 0);
  const conversions = Number(metrics?.conversions ?? 0);
  const cost = Number(metrics?.cost ?? 0);
  const ctr = Number.isFinite(Number(metrics?.ctr))
    ? Number(metrics.ctr)
    : impressions > 0
      ? clicks / impressions
      : 0;
  const conversionRate = Number.isFinite(Number(metrics?.conversionRate))
    ? Number(metrics.conversionRate)
    : clicks > 0
      ? conversions / clicks
      : 0;

  if (impressions < Number(rules.min_impressions ?? 0)) {
    return { low: false, reason: 'INSUFFICIENT_DATA' };
  }

  const reasons = [];
  if (ctr <= Number(rules.max_ctr ?? 0)) reasons.push('LOW_CTR');
  if (conversionRate <= Number(rules.max_conversion_rate ?? 0)) reasons.push('LOW_CONVERSION_RATE');
  if (cost >= Number(rules.min_cost ?? 0) && conversions <= 0) reasons.push('SPEND_WITHOUT_CONVERSIONS');

  return {
    low: reasons.length > 0,
    reason: reasons.join('+') || null,
    metrics: { impressions, clicks, conversions, cost, ctr, conversionRate },
  };
};

const GOOGLE_PERFORMANCE_LABELS_BY_CODE = new Map([
  [0, 'UNSPECIFIED'],
  [1, 'UNKNOWN'],
  [2, 'PENDING'],
  [3, 'LEARNING'],
  [4, 'LOW'],
  [5, 'GOOD'],
  [6, 'BEST'],
]);

const GOOGLE_AD_TYPES_BY_CODE = new Map([
  [14, 'IMAGE_AD'],
  [17, 'APP_AD'],
  [23, 'APP_ENGAGEMENT_AD'],
]);

const GOOGLE_ASSET_FIELD_TYPES_BY_CODE = new Map([
  [5, 'MARKETING_IMAGE'],
  [14, 'MARKETING_IMAGE'],
  [15, 'MARKETING_IMAGE_IN_PORTRAIT'],
  [16, 'SQUARE_MARKETING_IMAGE'],
  [17, 'PORTRAIT_MARKETING_IMAGE'],
  [19, 'SQUARE_MARKETING_IMAGE'],
  [20, 'PORTRAIT_MARKETING_IMAGE'],
  [26, 'AD_IMAGE'],
  [29, 'AD_IMAGE'],
  [32, 'TALL_PORTRAIT_MARKETING_IMAGE'],
]);

export const normalizeGoogleAdType = (type) => {
  if (typeof type === 'number') return GOOGLE_AD_TYPES_BY_CODE.get(type) || String(type);
  const numericType = Number(type);
  if (Number.isInteger(numericType) && String(type).trim() === String(numericType)) {
    return GOOGLE_AD_TYPES_BY_CODE.get(numericType) || String(type);
  }
  return String(type || '').toUpperCase();
};

export const normalizeGoogleAssetFieldType = (fieldType) => {
  if (typeof fieldType === 'number') return GOOGLE_ASSET_FIELD_TYPES_BY_CODE.get(fieldType) || String(fieldType);
  const numericFieldType = Number(fieldType);
  if (Number.isInteger(numericFieldType) && String(fieldType).trim() === String(numericFieldType)) {
    return GOOGLE_ASSET_FIELD_TYPES_BY_CODE.get(numericFieldType) || String(fieldType);
  }
  return String(fieldType || '').toUpperCase();
};

export const normalizeGooglePerformanceLabel = (label) => {
  if (typeof label === 'number') return GOOGLE_PERFORMANCE_LABELS_BY_CODE.get(label) || String(label);
  const numericLabel = Number(label);
  if (Number.isInteger(numericLabel) && String(label).trim() === String(numericLabel)) {
    return GOOGLE_PERFORMANCE_LABELS_BY_CODE.get(numericLabel) || String(label);
  }
  return String(label || '').toUpperCase();
};

export const isGoogleLowPerformanceLabel = (label, expectedLabel = 'LOW') =>
  normalizeGooglePerformanceLabel(label) === String(expectedLabel || 'LOW').toUpperCase();

const IMAGE_ASSET_FIELD_TYPES = new Set([
  'AD_IMAGE',
  'BUSINESS_LOGO',
  'DEMAND_GEN_CAROUSEL_CARD',
  'LANDSCAPE_LOGO',
  'LOGO',
  'MARKETING_IMAGE',
  'PORTRAIT_MARKETING_IMAGE',
  'SQUARE_MARKETING_IMAGE',
  'TALL_PORTRAIT_MARKETING_IMAGE',
]);

export const isImageAssetFieldType = (fieldType) =>
  IMAGE_ASSET_FIELD_TYPES.has(normalizeGoogleAssetFieldType(fieldType));

export const GOOGLE_REPLACEMENT_MODES = {
  STRICT_SAME_AD: 'strict_same_ad',
  ALLOW_GOOGLE_REQUIRED_CLONE: 'allow_google_required_clone',
};

export const normalizeGoogleReplacementMode = (mode) =>
  mode === GOOGLE_REPLACEMENT_MODES.ALLOW_GOOGLE_REQUIRED_CLONE
    ? GOOGLE_REPLACEMENT_MODES.ALLOW_GOOGLE_REQUIRED_CLONE
    : GOOGLE_REPLACEMENT_MODES.STRICT_SAME_AD;

export const describeGoogleReplacementCapability = (target = {}, mode = GOOGLE_REPLACEMENT_MODES.STRICT_SAME_AD) => {
  const replacementMode = normalizeGoogleReplacementMode(mode);
  const targetType = String(target.targetType || '').toUpperCase();
  const adType = normalizeGoogleAdType(target.adType);
  const replacementStrategy = String(target.replacementStrategy || '').toUpperCase();
  const supportedReplacement = target.supportedReplacement !== false;

  const isSameAdImageUpdate =
    supportedReplacement &&
    targetType === 'AD_GROUP_AD' &&
    adType === 'IMAGE_AD' &&
    (!replacementStrategy || replacementStrategy === 'IMAGE_AD_UPDATE');
  const isAppEngagementAdImageUpdate =
    supportedReplacement &&
    targetType === 'AD_GROUP_AD' &&
    adType === 'APP_ENGAGEMENT_AD' &&
    (!replacementStrategy ||
      replacementStrategy === 'APP_ENGAGEMENT_AD_UPDATE' ||
      replacementStrategy === 'APP_ENGAGEMENT_AD_CLONE_REPLACE');
  const isAssetGroupAssociation =
    supportedReplacement &&
    targetType === 'ASSET_GROUP_ASSET' &&
    (!replacementStrategy || replacementStrategy === 'ASSET_GROUP_ASSET_ASSOCIATION');
  const isAppInstallAd =
    supportedReplacement &&
    targetType === 'AD_GROUP_AD' &&
    adType === 'APP_AD';
  const requiresNewAd =
    supportedReplacement &&
    targetType === 'AD_GROUP_AD' &&
    !isAppInstallAd &&
    adType !== 'APP_ENGAGEMENT_AD' &&
    replacementStrategy.includes('CLONE_REPLACE');
  const canPreserveAdId = isSameAdImageUpdate || isAppEngagementAdImageUpdate;
  const canPreserveServingContainer = canPreserveAdId || isAssetGroupAssociation;
  const executableInMode =
    supportedReplacement &&
    !isAppInstallAd &&
    (canPreserveAdId ||
      (replacementMode === GOOGLE_REPLACEMENT_MODES.ALLOW_GOOGLE_REQUIRED_CLONE &&
        (requiresNewAd || isAssetGroupAssociation)));
  const executionPolicy = isAppInstallAd
    ? 'manual_only'
    : canPreserveAdId
    ? 'same_ad_update'
    : requiresNewAd
      ? 'clone_replace'
      : isAssetGroupAssociation
        ? 'asset_group_reassociation'
        : 'unsupported';
  let blockedReason = null;
  let blockedMessage = null;

  if (!supportedReplacement) {
    blockedReason = target.replacementSupportReason || target.supportReason || 'UNSUPPORTED_TARGET';
    blockedMessage = target.replacementSupportMessage || target.supportMessage || null;
  } else if (isAppInstallAd) {
    blockedReason = 'APP_AD_REPLACEMENT_REQUIRES_GOOGLE_ADS_UI';
    blockedMessage = 'Google Ads API cannot replace App Ad images automatically. Replace this creative directly in Google Ads.';
  } else if (!executableInMode && requiresNewAd) {
    blockedReason = 'REQUIRES_NEW_AD';
  } else if (!executableInMode && isAssetGroupAssociation) {
    blockedReason = 'NO_AD_ID_FOR_ASSET_GROUP_ASSET';
  } else if (!executableInMode) {
    blockedReason = 'UNSUPPORTED_SAME_AD_REPLACEMENT';
  }

  return {
    replacementMode,
    canPreserveAdId,
    canPreserveServingContainer,
    requiresNewAd,
    executableInMode,
    executionPolicy,
    blockedReason,
    blockedMessage,
  };
};

export const requiresNewAdCreationPermission = (operations = [], selectedOperationIds = null) => {
  const selectedIds = selectedOperationIds instanceof Set
    ? selectedOperationIds
    : Array.isArray(selectedOperationIds)
      ? new Set(selectedOperationIds.map((id) => String(id)))
      : null;

  return operations.some((operation) => {
    if (selectedIds && !selectedIds.has(String(operation.id))) return false;
    return operation.requiresNewAd === true;
  });
};

const plazasToSet = (value) =>
  new Set(
    normalizePlazas(value)
      .split(',')
      .map(normalizeComparableText)
      .filter(Boolean),
  );

export const selectCreativeForCategory = (
  creatives,
  category,
  strategy = 'oldest_first',
  reservedIds = new Set(),
  plazas = '',
) => {
  const normalizedCategory = String(category || '').toLowerCase();
  const candidates = creatives.filter(
    (creative) =>
      String(creative.category || '').toLowerCase() === normalizedCategory &&
      creative.status === 'available' &&
      !reservedIds.has(creative.creative_id),
  );
  const requestedPlazas = plazasToSet(plazas);
  const wantsAll = requestedPlazas.has('all');
  let available = candidates;
  if (requestedPlazas.size > 0) {
    const exactMatches = wantsAll
      ? []
      : candidates.filter((creative) => {
          const creativePlazas = plazasToSet(creative.plazas);
          return [...creativePlazas].some((plaza) => requestedPlazas.has(plaza));
        });
    const allMatches = candidates.filter((creative) => plazasToSet(creative.plazas).has('all'));
    available = exactMatches.length > 0 ? exactMatches : allMatches.length > 0 ? allMatches : candidates;
  }

  if (available.length === 0) return null;

  if (strategy === 'random') {
    return available[Math.floor(Math.random() * available.length)];
  }

  return [...available].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || '') || 0;
    const rightTime = Date.parse(right.created_at || '') || 0;
    return strategy === 'newest_first' ? rightTime - leftTime : leftTime - rightTime;
  })[0];
};

export const canTransitionCreativeStatus = (from, to) => {
  const allowed = {
    available: new Set(['reserved', 'archived']),
    reserved: new Set(['available', 'used', 'failed']),
    failed: new Set(['available', 'archived']),
    used: new Set(['archived']),
    archived: new Set(['available']),
  };

  return allowed[from]?.has(to) ?? false;
};
