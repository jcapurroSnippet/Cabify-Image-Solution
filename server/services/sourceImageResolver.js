import { downloadAdImage } from './adImageDownloader.js';
import { downloadDriveFileAsDataUrl, listDriveFolderImages } from './driveService.js';
import { getCreativeLibraryConfig } from './creativeLibraryConfig.js';

export const SOURCE_ORIGIN_LOW_PERFORMER = 'low_performer';
export const SOURCE_ORIGIN_BANK = 'bank';

const clean = (value) => String(value ?? '').trim();

/**
 * Dependency seam so tests can drive the resolver without Drive or the network.
 */
let sourceImageDependencyOverrides = {};

export const setSourceImageDependencyOverrides = (overrides = {}) => {
  sourceImageDependencyOverrides = overrides || {};
};

export const resetSourceImageDependencyOverrides = () => {
  sourceImageDependencyOverrides = {};
};

const downloadTargetImage = (...args) =>
  (sourceImageDependencyOverrides.downloadAdImage || downloadAdImage)(...args);
const listBankImages = (...args) =>
  (sourceImageDependencyOverrides.listDriveFolderImages || listDriveFolderImages)(...args);
const downloadBankImage = (...args) =>
  (sourceImageDependencyOverrides.downloadDriveFileAsDataUrl || downloadDriveFileAsDataUrl)(...args);
const readConfig = () =>
  (sourceImageDependencyOverrides.getCreativeLibraryConfig || getCreativeLibraryConfig)();

const isUsableDataUrl = (value) => /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(clean(value));

/**
 * Pick a bank image whose file name matches the detected category.
 * Falls back to the whole folder when nothing matches, so a run is never
 * blocked purely by naming conventions.
 */
export const selectBankImage = (files = [], category) => {
  const usable = (files || []).filter((file) => file?.id);
  if (usable.length === 0) return null;

  const categoryKey = clean(category).toLowerCase();
  if (categoryKey) {
    const matching = usable.filter((file) => clean(file.name).toLowerCase().includes(categoryKey));
    if (matching.length > 0) return matching[0];
  }

  return usable[0];
};

/**
 * Resolve the image a run should feed into generation for one target.
 *
 * Order: the low performer's own creative first (so the new piece is a direct
 * descendant of the one it replaces), then the Drive source bank.
 * Never throws — an unresolvable target is reported so the run can skip it and
 * keep going with the rest.
 *
 * Returns { origin, dataUrl, sourceUrl, error }.
 */
export const resolveSourceImage = async (target = {}, { bankFolderId, bankFiles } = {}) => {
  const attempts = [];

  const lowPerformerUrl = clean(target.old_image_url || target.oldImageUrl || target.assetUrl);
  if (lowPerformerUrl) {
    try {
      const dataUrl = await downloadTargetImage(lowPerformerUrl);
      if (isUsableDataUrl(dataUrl)) {
        return {
          origin: SOURCE_ORIGIN_LOW_PERFORMER,
          dataUrl,
          sourceUrl: lowPerformerUrl,
          error: null,
        };
      }
      attempts.push('low performer image was not a usable image');
    } catch (error) {
      attempts.push(`low performer image: ${error?.message || 'download failed'}`);
    }
  } else {
    attempts.push('low performer has no image URL');
  }

  const folderId = clean(bankFolderId) || clean(readConfig().sourceBankFolderId);
  if (!folderId) {
    attempts.push('no source bank folder configured (CREATIVE_SOURCE_BANK_FOLDER_ID)');
    return { origin: null, dataUrl: null, sourceUrl: null, error: attempts.join('; ') };
  }

  try {
    const files = bankFiles || await listBankImages(folderId);
    const picked = selectBankImage(files, target.detected_category || target.detectedCategory);
    if (!picked) {
      attempts.push('source bank folder has no images');
      return { origin: null, dataUrl: null, sourceUrl: null, error: attempts.join('; ') };
    }

    const dataUrl = await downloadBankImage(picked.id);
    if (!isUsableDataUrl(dataUrl)) {
      attempts.push('bank image was not a usable image');
      return { origin: null, dataUrl: null, sourceUrl: null, error: attempts.join('; ') };
    }

    return {
      origin: SOURCE_ORIGIN_BANK,
      dataUrl,
      sourceUrl: picked.webViewLink || `https://drive.google.com/file/d/${picked.id}/view`,
      error: null,
    };
  } catch (error) {
    attempts.push(`source bank: ${error?.message || 'lookup failed'}`);
    return { origin: null, dataUrl: null, sourceUrl: null, error: attempts.join('; ') };
  }
};
