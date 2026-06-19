import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle,
  ChevronDown,
  Database,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import type {
  AccountOption,
  CampaignOption,
  CreativeLibraryResponse,
  ExecutionResponse,
  LowPerformer,
  ReplacementMode,
  ReplacementPlanResponse,
  SyncResponse,
} from './types';
import {
  buildReplacementPlan,
  executeReplacements,
  fetchCreativeLibrary,
  fetchGoogleAccounts,
  fetchGoogleCampaigns,
  fetchLowPerformers,
  syncCreativeLibrary,
} from './services/creativeLibraryApi';

type BusyAction = 'sync' | 'list' | 'low' | 'plan' | 'execute' | 'accounts' | 'campaigns' | null;

const DEFAULT_CATEGORY_OPTIONS = [
  'Generic',
  'Promo',
  'Alianzas',
];

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Unexpected error.';

const formatCategoryLabel = (category?: string | null) => {
  const labels: Record<string, string> = {
    generic: 'Generic',
    promo: 'Promo',
    alianzas: 'Alianzas',
  };
  const normalized = String(category || '').trim().toLowerCase();
  return labels[normalized] || category || '-';
};

const getPreviewSrc = (url?: string | null) => {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  return `/api/image-preview?url=${encodeURIComponent(url)}`;
};

export default function CreativeLibraryTab() {
  const [sheetsUrl, setSheetsUrl] = useState('');
  const [sheetName, setSheetName] = useState('');
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [accountId, setAccountId] = useState('');
  const [campaignIds, setCampaignIds] = useState<string[]>([]);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [isCampaignMenuOpen, setIsCampaignMenuOpen] = useState(false);
  const [limit, setLimit] = useState(10);
  const [replacementMode, setReplacementMode] = useState<ReplacementMode>('strict_same_ad');
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResponse | null>(null);
  const [library, setLibrary] = useState<CreativeLibraryResponse | null>(null);
  const [lowPerformers, setLowPerformers] = useState<LowPerformer[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<string[]>(DEFAULT_CATEGORY_OPTIONS);
  const [lowPerformerCategories, setLowPerformerCategories] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<ReplacementPlanResponse | null>(null);
  const [execution, setExecution] = useState<ExecutionResponse | null>(null);
  const [selectedLowPerformerIds, setSelectedLowPerformerIds] = useState<Set<string>>(new Set());
  const [selectedOperationIds, setSelectedOperationIds] = useState<Set<string>>(new Set());
  const campaignMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let isActive = true;
    setBusyAction('accounts');
    fetchGoogleAccounts()
      .then((items) => {
        if (!isActive) return;
        setAccounts(items);
        if (items[0]) setAccountId(items[0].id);
      })
      .catch((err) => {
        if (isActive) setError(getErrorMessage(err));
      })
      .finally(() => {
        if (isActive) setBusyAction(null);
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!accountId) {
      setCampaigns([]);
      setCampaignIds([]);
      return;
    }

    let isActive = true;
    setBusyAction('campaigns');
    fetchGoogleCampaigns(accountId)
      .then((items) => {
        if (!isActive) return;
        setCampaigns(items);
        setCampaignIds([]);
      })
      .catch((err) => {
        if (isActive) setError(getErrorMessage(err));
      })
      .finally(() => {
        if (isActive) setBusyAction(null);
      });

    return () => {
      isActive = false;
    };
  }, [accountId]);

  useEffect(() => {
    setLowPerformers([]);
    setLowPerformerCategories({});
    setSelectedLowPerformerIds(new Set());
    setPlan(null);
    setExecution(null);
    setSelectedOperationIds(new Set());
  }, [accountId, campaignIds, limit, replacementMode]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!campaignMenuRef.current?.contains(event.target as Node)) {
        setIsCampaignMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsCampaignMenuOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const availableCount = useMemo(
    () => library?.creatives.filter((creative) => creative.status === 'available').length || 0,
    [library],
  );
  const selectedCampaignCount = campaignIds.length;
  const selectedCampaignIdSet = useMemo(() => new Set(campaignIds), [campaignIds]);
  const selectedCampaignLabel = useMemo(() => {
    if (selectedCampaignCount === 0) return 'All enabled campaigns';
    if (selectedCampaignCount === 1) {
      return campaigns.find((campaign) => campaign.id === campaignIds[0])?.label || '1 campaign selected';
    }
    return `${selectedCampaignCount} campaigns selected`;
  }, [campaignIds, campaigns, selectedCampaignCount]);
  const filteredCampaigns = useMemo(() => {
    const query = campaignSearch.trim().toLowerCase();
    if (!query) return campaigns;
    return campaigns.filter((campaign) =>
      `${campaign.label} ${campaign.id}`.toLowerCase().includes(query),
    );
  }, [campaignSearch, campaigns]);

  const validateSheet = () => {
    if (!sheetsUrl.trim()) {
      setError('Google Sheets URL is required.');
      return false;
    }
    return true;
  };

  const validateAds = () => {
    if (!accountId) {
      setError('Google Ads account is required.');
      return false;
    }
    return true;
  };

  const runAction = async (action: Exclude<BusyAction, null>, task: () => Promise<void>) => {
    setBusyAction(action);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleSync = () => {
    if (!validateSheet()) return;
    void runAction('sync', async () => {
      try {
        const result = await syncCreativeLibrary(sheetsUrl.trim(), sheetName.trim() || undefined);
        console.info('[Creative Library] Sync result', result);
        if (result.failureDetails?.length) {
          console.error('[Creative Library] Sync failures', result.failureDetails);
        }
        const nextLibrary = await fetchCreativeLibrary(sheetsUrl.trim());
        setSyncResult(result);
        setLibrary(nextLibrary);
        setCategoryOptions(nextLibrary.categories?.length ? nextLibrary.categories : DEFAULT_CATEGORY_OPTIONS);
      } catch (err) {
        console.error('[Creative Library] Sync failed', err);
        throw err;
      }
    });
  };

  const handleList = () => {
    if (!validateSheet()) return;
    void runAction('list', async () => {
      const nextLibrary = await fetchCreativeLibrary(sheetsUrl.trim());
      setLibrary(nextLibrary);
      setCategoryOptions(nextLibrary.categories?.length ? nextLibrary.categories : DEFAULT_CATEGORY_OPTIONS);
    });
  };

  const handleLowPerformers = () => {
    if (!validateAds()) return;
    void runAction('low', async () => {
      const result = await fetchLowPerformers(sheetsUrl.trim(), accountId, campaignIds, limit);
      const assets = result.assets;
      setLowPerformers(assets);
      setCategoryOptions(result.categories.length > 0 ? result.categories : DEFAULT_CATEGORY_OPTIONS);
      setLowPerformerCategories(
        Object.fromEntries(
          assets
            .filter((asset) => asset.id)
            .map((asset) => [asset.id, asset.detectedCategory || '']),
        ),
      );
      setSelectedLowPerformerIds(new Set(assets.map((asset) => asset.id).filter(Boolean)));
      setPlan(null);
      setExecution(null);
    });
  };

  const getSelectedLowPerformerCategories = () =>
    Object.fromEntries(
      lowPerformers
        .filter((asset) => selectedLowPerformerIds.has(asset.id))
        .map((asset) => [asset.id, lowPerformerCategories[asset.id] || ''])
        .filter(([assetId, category]) => {
          if (!category) return false;
          const asset = lowPerformers.find((item) => item.id === assetId);
          return String(category).toLowerCase() !== String(asset?.detectedCategory || '').toLowerCase();
        }),
    );

  const handlePlan = () => {
    if (!validateSheet() || !validateAds()) return;
    const selectedLowIds = lowPerformers.length > 0 ? [...selectedLowPerformerIds] : undefined;
    const selectedCategories = lowPerformers.length > 0 ? getSelectedLowPerformerCategories() : undefined;
    if (lowPerformers.length > 0 && selectedLowIds?.length === 0) {
      setError('Select at least one low performer before building the dry run.');
      return;
    }

    void runAction('plan', async () => {
      const nextPlan = await buildReplacementPlan(
        sheetsUrl.trim(),
        accountId,
        campaignIds,
        limit,
        selectedLowIds,
        selectedCategories,
        replacementMode,
      );
      setPlan(nextPlan);
      setSelectedOperationIds(
        new Set(
          nextPlan.operations
            .filter((operation) => operation.status === 'planned' && operation.executableInMode)
            .map((operation) => operation.id),
        ),
      );
    });
  };

  const handleExecute = () => {
    if (!validateSheet() || !validateAds()) return;
    const selectedIds = [...selectedOperationIds];
    const selectedLowIds = lowPerformers.length > 0 ? [...selectedLowPerformerIds] : undefined;
    const selectedCategories = lowPerformers.length > 0 ? getSelectedLowPerformerCategories() : undefined;
    if (selectedIds.length === 0) {
      setError('Select at least one replacement before executing.');
      return;
    }
    const confirmed = window.confirm(`Execute ${selectedIds.length} selected Google Ads replacement${selectedIds.length === 1 ? '' : 's'} now?`);
    if (!confirmed) return;

    void runAction('execute', async () => {
      const result = await executeReplacements(
        sheetsUrl.trim(),
        accountId,
        campaignIds,
        limit,
        selectedIds,
        selectedLowIds,
        selectedCategories,
        replacementMode,
      );
      setExecution(result);
      setLibrary(await fetchCreativeLibrary(sheetsUrl.trim()));
    });
  };

  const toggleOperation = (operationId: string) => {
    setSelectedOperationIds((previous) => {
      const next = new Set(previous);
      if (next.has(operationId)) {
        next.delete(operationId);
      } else {
        next.add(operationId);
      }
      return next;
    });
  };

  const toggleLowPerformer = (assetId: string) => {
    setSelectedLowPerformerIds((previous) => {
      const next = new Set(previous);
      if (next.has(assetId)) {
        next.delete(assetId);
      } else {
        next.add(assetId);
      }
      return next;
    });
  };

  const toggleCampaign = (selectedCampaignId: string) => {
    setCampaignIds((previous) =>
      previous.includes(selectedCampaignId)
        ? previous.filter((id) => id !== selectedCampaignId)
        : [...previous, selectedCampaignId],
    );
  };

  const updateLowPerformerCategory = (assetId: string, category: string) => {
    setLowPerformerCategories((previous) => ({
      ...previous,
      [assetId]: category,
    }));
    setPlan(null);
    setExecution(null);
    setSelectedOperationIds(new Set());
  };

  const clearCampaignSelection = () => {
    setCampaignIds([]);
    setCampaignSearch('');
  };

  const selectAllLowPerformers = () => {
    setSelectedLowPerformerIds(new Set(lowPerformers.map((asset) => asset.id).filter(Boolean)));
  };

  const clearLowPerformers = () => {
    setSelectedLowPerformerIds(new Set());
  };

  const selectedExecutableCount = plan
    ? plan.operations.filter((operation) => selectedOperationIds.has(operation.id) && operation.executableInMode).length
    : 0;
  const selectedLowPerformerCount = lowPerformers.filter((asset) => selectedLowPerformerIds.has(asset.id)).length;
  const getLowPerformerCategoryValue = (asset: LowPerformer) =>
    lowPerformerCategories[asset.id] || asset.detectedCategory || '';
  const getLowPerformerCategoryOptions = (asset: LowPerformer) => {
    const detectedCategory = String(asset.detectedCategory || '').trim();
    const hasDetectedOption = categoryOptions.some(
      (category) => String(category).toLowerCase() === detectedCategory.toLowerCase(),
    );

    return detectedCategory && !hasDetectedOption
      ? [detectedCategory, ...categoryOptions]
      : categoryOptions;
  };

  const isBusy = busyAction !== null;

  return (
    <div className="space-y-4">
      <section className="panel-surface space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">Creative Library</h3>
            <p className="mt-1 text-sm text-slate-400">Accepted creatives, category matching, and Google Ads replacement.</p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-lg border border-slate-700/70 px-3 py-2 text-sm text-slate-300">
            <Database className="h-4 w-4" />
            {library ? `${library.summary.total} creatives` : 'No library loaded'}
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[1.5fr_0.7fr]">
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase text-slate-400">Google Sheet URL</span>
            <input
              value={sheetsUrl}
              onChange={(event) => setSheetsUrl(event.target.value)}
              className="w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/70"
              placeholder="https://docs.google.com/spreadsheets/d/..."
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase text-slate-400">Sheet tab</span>
            <input
              value={sheetName}
              onChange={(event) => setSheetName(event.target.value)}
              className="w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/70"
              placeholder="Auto"
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleSync}
            disabled={isBusy}
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {busyAction === 'sync' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sync accepted
          </button>
          <button
            type="button"
            onClick={handleList}
            disabled={isBusy}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700/80 px-4 py-2 text-sm text-slate-200 hover:border-slate-500 disabled:cursor-not-allowed disabled:text-slate-500"
          >
            {busyAction === 'list' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
            Load library
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {syncResult && (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-4">
              {['stored', 'alreadyStored', 'missingCategory', 'storageFailed'].map((key) => (
                <div key={key} className="rounded-lg border border-slate-700/70 bg-slate-900/40 p-3">
                  <p className="text-xs uppercase text-slate-400">{key}</p>
                  <p className="mt-1 text-2xl font-semibold text-white">{syncResult.totals[key] || 0}</p>
                </div>
              ))}
            </div>

            {syncResult.debugLogPath && (
              <p className="text-xs text-slate-500">Sync log: {syncResult.debugLogPath}</p>
            )}

            {syncResult.failureDetails?.length ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-100">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 space-y-2">
                    <p className="font-medium">Storage failures</p>
                    {syncResult.failureDetails.slice(0, 8).map((failure) => (
                      <p key={`${failure.rowNumber}-${failure.sourceCell}`} className="break-words text-red-100/90">
                        Row {failure.rowNumber} ({failure.sourceCell}): {failure.error}
                      </p>
                    ))}
                    {syncResult.failureDetails.length > 8 && (
                      <p className="text-red-100/70">
                        {syncResult.failureDetails.length - 8} more failures in the sync log.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section className="panel-surface space-y-4">
        <div className="grid gap-3 lg:grid-cols-[1fr_1.15fr_0.45fr]">
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase text-slate-400">Google Ads account</span>
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              className="w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/70"
            >
              {accounts.length === 0 && <option value="">No accounts</option>}
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.label}</option>
              ))}
            </select>
          </label>
          <div className="relative space-y-1" ref={campaignMenuRef}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase text-slate-400">Campaigns</span>
              <span className="text-xs text-slate-500">
                {selectedCampaignCount > 0 ? `${selectedCampaignCount} selected` : 'All enabled'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsCampaignMenuOpen((isOpen) => !isOpen)}
              aria-expanded={isCampaignMenuOpen}
              className="flex h-10 w-full items-center gap-2 rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 text-left text-sm text-white outline-none hover:border-slate-500 focus:border-cyan-300/70"
            >
              <span className="min-w-0 flex-1 truncate">{selectedCampaignLabel}</span>
              {selectedCampaignCount > 0 && (
                <span className="rounded-md bg-cyan-300/15 px-1.5 py-0.5 text-xs text-cyan-100">
                  {selectedCampaignCount}
                </span>
              )}
              <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${isCampaignMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {isCampaignMenuOpen && (
              <div className="absolute left-0 right-0 z-30 mt-2 overflow-hidden rounded-lg border border-slate-700/90 bg-slate-950 shadow-xl shadow-slate-950/40">
                <div className="border-b border-slate-800 p-2">
                  <div className="flex h-9 items-center gap-2 rounded-md border border-slate-700/80 bg-slate-900/80 px-2">
                    <Search className="h-4 w-4 shrink-0 text-slate-500" />
                    <input
                      value={campaignSearch}
                      onChange={(event) => setCampaignSearch(event.target.value)}
                      className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-slate-500"
                      placeholder="Search campaign"
                    />
                    {campaignSearch && (
                      <button
                        type="button"
                        onClick={() => setCampaignSearch('')}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto py-1 text-sm">
                  <button
                    type="button"
                    onClick={clearCampaignSelection}
                    aria-pressed={selectedCampaignCount === 0}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-200 hover:bg-slate-900"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-slate-600 bg-slate-950/50">
                      {selectedCampaignCount === 0 && <Check className="h-3.5 w-3.5 text-green-400" />}
                    </span>
                    <span className="min-w-0 truncate">All enabled campaigns</span>
                  </button>
                  {campaigns.length === 0 && (
                    <div className="px-3 py-2 text-slate-500">
                      {busyAction === 'campaigns' ? 'Loading campaigns' : 'No campaigns'}
                    </div>
                  )}
                  {campaigns.length > 0 && filteredCampaigns.length === 0 && (
                    <div className="px-3 py-2 text-slate-500">No matches</div>
                  )}
                  {filteredCampaigns.map((campaign) => {
                    const isSelected = selectedCampaignIdSet.has(campaign.id);
                    return (
                      <button
                        key={campaign.id}
                        type="button"
                        onClick={() => toggleCampaign(campaign.id)}
                        aria-pressed={isSelected}
                        title={campaign.label}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-200 hover:bg-slate-900"
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-slate-600 bg-slate-950/50">
                          {isSelected && <Check className="h-3.5 w-3.5 text-green-400" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{campaign.label}</span>
                        <span className="shrink-0 text-xs text-slate-600">{campaign.id}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase text-slate-400">Limit</span>
            <input
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              className="w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/70"
            />
          </label>
          <label className="space-y-1 lg:col-span-3">
            <span className="text-xs font-medium uppercase text-slate-400">Replacement mode</span>
            <select
              value={replacementMode}
              onChange={(event) => setReplacementMode(event.target.value as ReplacementMode)}
              className="w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/70"
            >
              <option value="strict_same_ad">Same ad only</option>
              <option value="allow_google_required_clone">Allow Google-required clone/reassociation</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleLowPerformers}
            disabled={isBusy}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700/80 px-4 py-2 text-sm text-slate-200 hover:border-slate-500 disabled:cursor-not-allowed disabled:text-slate-500"
          >
            {busyAction === 'low' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Detect low performers
          </button>
          <button
            type="button"
            onClick={handlePlan}
            disabled={isBusy || (lowPerformers.length > 0 && selectedLowPerformerCount === 0)}
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {busyAction === 'plan' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Dry run{lowPerformers.length > 0 ? ` selected (${selectedLowPerformerCount})` : ''}
          </button>
          <button
            type="button"
            onClick={handleExecute}
            disabled={isBusy || !plan || selectedExecutableCount === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-100 hover:border-slate-500 disabled:cursor-not-allowed disabled:text-slate-500"
          >
            {busyAction === 'execute' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Execute selected{selectedExecutableCount > 0 ? ` (${selectedExecutableCount})` : ''}
          </button>
        </div>
      </section>

      {library && (
        <section className="panel-surface space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-medium uppercase text-slate-400">Library</h3>
            <span className="rounded-md bg-slate-900/40 px-2 py-1 text-xs text-slate-300">{availableCount} available</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {Object.entries(library.summary.byCategory).map(([category, counts]) => (
              <div key={category} className="rounded-lg border border-slate-700/70 bg-slate-900/40 p-3">
                <p className="text-sm font-semibold text-white">{formatCategoryLabel(category)}</p>
                <p className="mt-1 text-xs text-slate-400">{counts.available || 0} available / {counts.total || 0} total</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {(lowPerformers.length > 0 || plan) && (
        <section className="panel-surface space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-sm font-medium uppercase text-slate-400">Google Ads</h3>
            {lowPerformers.length > 0 && <span className="rounded-md bg-slate-900/40 px-2 py-1 text-xs text-slate-300">{lowPerformers.length} low performers</span>}
            {lowPerformers.length > 0 && <span className="rounded-md bg-slate-900/40 px-2 py-1 text-xs text-slate-300">{selectedLowPerformerCount} selected for dry run</span>}
            {plan && <span className="rounded-md bg-slate-900/40 px-2 py-1 text-xs text-slate-300">{plan.summary.executable || 0} executable</span>}
            {plan && <span className="rounded-md bg-slate-900/40 px-2 py-1 text-xs text-slate-300">{selectedExecutableCount} selected</span>}
            {!plan && lowPerformers.length > 0 && (
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={selectAllLowPerformers}
                  className="rounded-md border border-slate-700/80 px-2 py-1 text-xs text-slate-200 hover:border-slate-500"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={clearLowPerformers}
                  className="rounded-md border border-slate-700/80 px-2 py-1 text-xs text-slate-200 hover:border-slate-500"
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          {plan ? (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Apply</th>
                    <th className="px-3 py-2">Preview</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Strategy</th>
                    <th className="px-3 py-2">Campaign</th>
                    <th className="px-3 py-2">Resolution</th>
                    <th className="px-3 py-2">Asset</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Plazas</th>
                    <th className="px-3 py-2">Creative</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/60">
                  {plan.operations.slice(0, 20).map((operation) => (
                    <tr key={operation.id}>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => toggleOperation(operation.id)}
                          disabled={operation.status !== 'planned' || !operation.executableInMode}
                          aria-pressed={selectedOperationIds.has(operation.id)}
                          className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-700/80 bg-slate-900/40 text-slate-200 disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          {selectedOperationIds.has(operation.id) && <Check className="h-4 w-4 text-green-400" />}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-14 w-14 overflow-hidden rounded-md border border-slate-700/70 bg-slate-900/40">
                            {operation.oldAssetUrl ? (
                              <img src={getPreviewSrc(operation.oldAssetUrl)} alt="Current low performer" className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full items-center justify-center text-[10px] text-slate-500">No image</div>
                            )}
                          </div>
                          <div className="h-14 w-14 overflow-hidden rounded-md border border-slate-700/70 bg-slate-900/40">
                            {operation.creative?.drive_url ? (
                              <img src={getPreviewSrc(operation.creative.drive_url)} alt="Replacement creative" className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full items-center justify-center text-[10px] text-slate-500">No match</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1 rounded-md bg-slate-900/40 px-2 py-1 text-xs text-slate-200">
                          {operation.status === 'planned' && operation.executableInMode ? <CheckCircle className="h-3 w-3 text-green-400" /> : <AlertCircle className="h-3 w-3 text-amber-100" />}
                          {operation.executableInMode ? operation.status : operation.blockedReason || operation.message}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-300">
                        {operation.executionPolicy === 'same_ad_update' && 'Same ad'}
                        {operation.executionPolicy === 'clone_replace' && 'Clone'}
                        {operation.executionPolicy === 'asset_group_reassociation' && 'Asset group'}
                        {!operation.executionPolicy || operation.executionPolicy === 'unsupported' ? '-' : ''}
                      </td>
                      <td className="px-3 py-2 text-slate-200">
                        <p>{operation.campaignName}</p>
                        <p className="text-xs text-slate-500">{operation.adGroupName || operation.assetGroupName}</p>
                      </td>
                      <td className="px-3 py-2 text-slate-300">{operation.oldImageResolution || '-'}</td>
                      <td className="px-3 py-2">
                        {operation.googleAdsUrl ? (
                          <a
                            href={operation.googleAdsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-md border border-slate-700/80 px-2 py-1 text-xs text-slate-200 hover:border-cyan-300/70 hover:text-cyan-100"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Open
                          </a>
                        ) : (
                          <span className="text-slate-500">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-300">{formatCategoryLabel(operation.detectedCategory)}</td>
                      <td className="px-3 py-2 text-slate-300">
                        <p>{operation.detectedPlazas || '-'}</p>
                        {operation.creative?.plazas && (
                          <p className="text-xs text-slate-500">Creative: {operation.creative.plazas}</p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-300">{operation.creative?.creative_id || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Apply</th>
                    <th className="px-3 py-2">Preview</th>
                    <th className="px-3 py-2">Campaign</th>
                    <th className="px-3 py-2">Ad group</th>
                    <th className="px-3 py-2">Category</th>
                    <th className="px-3 py-2">Plazas</th>
                    <th className="px-3 py-2">Resolution</th>
                    <th className="px-3 py-2">Asset</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/60">
                  {lowPerformers.slice(0, 20).map((asset) => (
                    <tr key={asset.id}>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => toggleLowPerformer(asset.id)}
                          aria-pressed={selectedLowPerformerIds.has(asset.id)}
                          className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-700/80 bg-slate-900/40 text-slate-200"
                        >
                          {selectedLowPerformerIds.has(asset.id) && <Check className="h-4 w-4 text-green-400" />}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="h-14 w-14 overflow-hidden rounded-md border border-slate-700/70 bg-slate-900/40">
                          {asset.assetUrl ? (
                            <img src={getPreviewSrc(asset.assetUrl)} alt="Low performer" className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full items-center justify-center text-[10px] text-slate-500">No image</div>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-200">{asset.campaignName}</td>
                      <td className="px-3 py-2 text-slate-300">{asset.adGroupName || asset.assetGroupName}</td>
                      <td className="px-3 py-2">
                        <select
                          value={getLowPerformerCategoryValue(asset)}
                          onChange={(event) => updateLowPerformerCategory(asset.id, event.target.value)}
                          className="w-36 rounded-md border border-slate-700/80 bg-slate-900/70 px-2 py-1 text-xs text-white outline-none focus:border-cyan-300/70"
                        >
                          {!getLowPerformerCategoryValue(asset) && <option value="">No category detected</option>}
                          {getLowPerformerCategoryOptions(asset).map((category) => (
                            <option key={category} value={category}>{formatCategoryLabel(category)}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-slate-300">{asset.detectedPlazas || '-'}</td>
                      <td className="px-3 py-2 text-slate-300">{asset.imageResolution || '-'}</td>
                      <td className="px-3 py-2">
                        {asset.googleAdsUrl ? (
                          <a
                            href={asset.googleAdsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded-md border border-slate-700/80 px-2 py-1 text-xs text-slate-200 hover:border-cyan-300/70 hover:text-cyan-100"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Open
                          </a>
                        ) : (
                          <span className="text-slate-500">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {execution && (
        <section className="panel-surface">
          <div className="grid gap-2 sm:grid-cols-4">
            {['success', 'failed', 'skipped', 'attempted'].map((key) => (
              <div key={key} className="rounded-lg border border-slate-700/70 bg-slate-900/40 p-3">
                <p className="text-xs uppercase text-slate-400">{key}</p>
                <p className="mt-1 text-2xl font-semibold text-white">{execution.summary[key] || 0}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
