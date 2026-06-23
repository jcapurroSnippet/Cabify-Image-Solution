const isExecutable = (operation) =>
  operation?.status === 'planned' && operation?.executableInMode !== false && Boolean(operation?.creative);

const parsePlazas = (value) =>
  (String(value || '').match(/[a-z0-9]+/gi) || [])
    .map((plaza) => plaza.trim().toUpperCase())
    .filter(Boolean);

const normalizeResolution = (value) => {
  const match = String(value || '').match(/(\d+)\s*[xX]\s*(\d+)/);
  return match ? `${match[1]}x${match[2]}` : '';
};

export const summarizeCreativeLibraryPlazas = (creatives = [], category) => {
  const normalizedCategory = String(category || '').trim().toLowerCase();
  const plazaCounts = new Map();

  for (const creative of creatives) {
    if (String(creative?.category || '').trim().toLowerCase() !== normalizedCategory) continue;
    if (String(creative?.status || '').trim().toLowerCase() !== 'available') continue;

    for (const plaza of parsePlazas(creative.plazas)) {
      plazaCounts.set(plaza, (plazaCounts.get(plaza) || 0) + 1);
    }
  }

  return [...plazaCounts.entries()]
    .map(([plaza, count]) => ({ plaza, count }))
    .sort((left, right) => {
      if (left.plaza === 'ALL') return -1;
      if (right.plaza === 'ALL') return 1;
      return left.plaza.localeCompare(right.plaza);
    });
};

export const summarizeCreativeLibraryResolutions = (creatives = [], category) => {
  const normalizedCategory = String(category || '').trim().toLowerCase();
  const resolutionCounts = new Map();

  for (const creative of creatives) {
    if (String(creative?.category || '').trim().toLowerCase() !== normalizedCategory) continue;
    if (String(creative?.status || '').trim().toLowerCase() !== 'available') continue;

    const resolution = normalizeResolution(creative.image_resolution);
    if (!resolution) continue;
    resolutionCounts.set(resolution, (resolutionCounts.get(resolution) || 0) + 1);
  }

  return [...resolutionCounts.entries()]
    .map(([resolution, count]) => ({ resolution, count }))
    .sort((left, right) => left.resolution.localeCompare(right.resolution));
};

export const describeGoogleAdType = (target = {}) => {
  const adType = String(target.adType || '').toUpperCase();
  const targetType = String(target.targetType || '').toUpperCase();

  if (targetType === 'ASSET_GROUP_ASSET' || adType === 'ASSET_GROUP_ASSET') {
    return {
      label: 'Asset group asset',
      description: 'Replaces the asset association in an asset group.',
    };
  }

  if (adType === 'APP_ENGAGEMENT_AD') {
    return {
      label: 'App engagement ad',
      description: 'Updates the image list on the existing ad.',
    };
  }

  if (adType === 'APP_AD') {
    return {
      label: 'App install ad',
      description: 'Needs a manual change in Google Ads.',
    };
  }

  if (adType === 'IMAGE_AD') {
    return {
      label: 'Image ad',
      description: 'Updates the existing image ad.',
    };
  }

  return {
    label: 'Google Ads target',
    description: 'Review this item before replacing.',
  };
};

export const describeReplacementChange = (operation) => {
  if (!operation || operation.executableInMode === false || operation.executionPolicy === 'manual_only') {
    return {
      label: 'Replace in Google',
      description: 'This one needs a manual change in Google Ads.',
      tone: 'warning',
    };
  }

  if (operation.requiresNewAd || operation.executionPolicy === 'clone_replace') {
    return {
      label: 'Creates new ad',
      description: 'Google needs a new ad for this ad type.',
      tone: 'approval',
    };
  }

  if (operation.executionPolicy === 'asset_group_reassociation') {
    return {
      label: 'Updates asset group',
      description: 'The campaign container stays in place.',
      tone: 'ready',
    };
  }

  return {
    label: 'Updates current ad',
    description: 'The replacement is applied to the current ad.',
    tone: 'ready',
  };
};

export const describeReplacementStatus = (operation) => {
  if (operation?.message === 'NO_AVAILABLE_CREATIVE_FOR_RATIO') {
    const ratio = operation.requiredAspectRatio || 'matching';
    return {
      label: `No ${ratio} creative`,
      description: `Generate or sync a ${ratio} creative before replacing.`,
      tone: 'warning',
    };
  }

  if (!operation?.creative) {
    return {
      label: 'No creative',
      description: 'There is no available creative for this category and plaza.',
      tone: 'warning',
    };
  }

  if (operation.executableInMode === false || operation.executionPolicy === 'manual_only') {
    return {
      label: 'Manual change',
      description: operation.blockedMessage || 'Replace this creative directly in Google Ads.',
      tone: 'warning',
    };
  }

  if (operation.requiresNewAd || operation.executionPolicy === 'clone_replace') {
    return {
      label: 'Needs approval',
      description: 'This can run after you approve creating a new ad.',
      tone: 'approval',
    };
  }

  if (operation.executionStatus === 'failed' || operation.status === 'failed') {
    return {
      label: 'Failed',
      description: operation.executionMessage || operation.message || 'The replacement did not finish.',
      tone: 'error',
    };
  }

  if (operation.executionStatus === 'success' || operation.status === 'success') {
    return {
      label: 'Replaced',
      description: operation.executionMessage || operation.message || 'The creative was replaced.',
      tone: 'ready',
    };
  }

  if (isExecutable(operation)) {
    return {
      label: 'Ready',
      description: 'Ready to replace.',
      tone: 'ready',
    };
  }

  return {
    label: 'Needs review',
    description: operation.blockedMessage || operation.message || 'Review this replacement before running.',
    tone: 'warning',
  };
};

export const summarizeReplacementSelection = (operations, selectedIds) => {
  const selected = operations.filter((operation) => selectedIds.has(operation.id));
  return selected.reduce(
    (summary, operation) => {
      summary.selected += 1;

      if (operation.executableInMode === false || operation.executionPolicy === 'manual_only') {
        summary.manual += 1;
      } else if (operation.requiresNewAd || operation.executionPolicy === 'clone_replace') {
        summary.needsNewAd += 1;
      } else if (isExecutable(operation)) {
        summary.ready += 1;
      } else {
        summary.blocked += 1;
      }

      return summary;
    },
    {
      selected: 0,
      ready: 0,
      needsNewAd: 0,
      manual: 0,
      blocked: 0,
    },
  );
};

export const buildNewAdPermissionMessage = (newAdCount, selectedCount) => {
  const replacementWord = newAdCount === 1 ? 'replacement' : 'replacements';
  const totalWord = selectedCount === 1 ? 'creative' : 'creatives';
  return [
    `Google needs to create a new ad for ${newAdCount} ${replacementWord}.`,
    `You selected ${selectedCount} ${totalWord}. This can change the ad ID for those replacements, while keeping the campaign and ad group context.`,
    'Continue and replace?',
  ].join('\n\n');
};

export const buildReplacementCompletedItems = (summary = {}) => [
  ['Replaced', summary.success || 0],
  ['Needs attention', summary.failed || 0],
  ['Skipped', summary.skipped || 0],
  ['Reviewed', summary.attempted || 0],
];
