import React, { useEffect, useState } from 'react';
import { ClipboardCheck, Crop, Library, Sparkles, TrendingDown, Workflow, Wrench } from 'lucide-react';
import {
  CABIFY_ACCOUNTS,
  DEFAULT_CABIFY_ACCOUNT,
  normalizeCabifyAccount,
  type CabifyAccountId,
} from '../prompts/accounts.js';
import AspectRatioTab from './features/aspect-ratio/AspectRatioTab';
import NanoEditorTab from './features/nano-editor/NanoEditorTab';
import AdOptimizerTab from './features/ad-optimizer/AdOptimizerTab';
import CreativeLibraryTab from './features/creative-library/CreativeLibraryTab';
import CreativeReviewPortal from './features/creative-review/CreativeReviewPortal';
import ReviewBatchesTab from './features/creative-review/ReviewBatchesTab';
import RunFunnelTab from './features/run-funnel/RunFunnelTab';

type ToolId = 'nano' | 'ratio' | 'optimizer' | 'library' | 'review';
type TabId = 'funnel' | ToolId;

const TOOL_ITEMS: Array<{ id: ToolId; label: string; icon: React.ReactNode }> = [
  {
    id: 'nano',
    label: 'Nano Editor',
    icon: <Sparkles className="h-4 w-4" />,
  },
  {
    id: 'ratio',
    label: 'Aspect Ratio',
    icon: <Crop className="h-4 w-4" />,
  },
  {
    id: 'optimizer',
    label: 'Editor Batch',
    icon: <TrendingDown className="h-4 w-4" />,
  },
  {
    id: 'library',
    label: 'Creative Library',
    icon: <Library className="h-4 w-4" />,
  },
  {
    id: 'review',
    label: 'Creative Review',
    icon: <ClipboardCheck className="h-4 w-4" />,
  },
];

const TOOL_IDS = TOOL_ITEMS.map((tool) => tool.id);

const getPublicReviewToken = (pathname: string, hash: string) => {
  const fragment = hash.replace(/^#/, '');
  if (fragment) {
    const tokenFromParams = new URLSearchParams(fragment).get('token');
    const fragmentToken = tokenFromParams || fragment;
    try {
      return decodeURIComponent(fragmentToken);
    } catch {
      return fragmentToken;
    }
  }
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  const match = normalizedPath.match(/^\/r\/([^/]+)$/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const getTabFromLocation = (): TabId => {
  const requestedTab = new URLSearchParams(window.location.search).get('tab');
  if (requestedTab === 'funnel') return 'funnel';
  return TOOL_IDS.includes(requestedTab as ToolId) ? requestedTab as ToolId : 'funnel';
};

const getAccountFromLocation = (): CabifyAccountId =>
  normalizeCabifyAccount(new URLSearchParams(window.location.search).get('account'))
  ?? DEFAULT_CABIFY_ACCOUNT;

/** Writes one query param without adding a history entry; `null` removes it. */
const replaceSearchParam = (name: string, value: string | null) => {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
};

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>(getTabFromLocation);
  // Every tool generates with the prompts of this account (prompts/<account>/).
  const [account, setAccount] = useState<CabifyAccountId>(getAccountFromLocation);
  const normalizedPath = window.location.pathname.replace(/\/+$/, '') || '/';
  const publicReviewToken = getPublicReviewToken(window.location.pathname, window.location.hash);
  const isPublicReview = normalizedPath === '/review' || normalizedPath === '/r' || normalizedPath.startsWith('/r/');

  useEffect(() => {
    const syncFromLocation = () => {
      setActiveTab(getTabFromLocation());
      setAccount(getAccountFromLocation());
    };
    window.addEventListener('popstate', syncFromLocation);
    return () => window.removeEventListener('popstate', syncFromLocation);
  }, []);

  const selectTab = (tabId: TabId) => {
    setActiveTab(tabId);
    replaceSearchParam('tab', tabId === 'funnel' ? null : tabId);
  };

  const selectAccount = (accountId: CabifyAccountId) => {
    setAccount(accountId);
    replaceSearchParam('account', accountId === DEFAULT_CABIFY_ACCOUNT ? null : accountId);
  };

  if (isPublicReview) return <CreativeReviewPortal token={publicReviewToken} />;

  const isToolsSection = activeTab !== 'funnel';
  const isWide = activeTab === 'review' || activeTab === 'funnel';

  return (
    <div className="min-h-screen px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className={`mx-auto space-y-4 ${isWide ? 'max-w-[1600px]' : 'max-w-7xl'}`}>
        <header className="panel-surface">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3 sm:gap-4">
              <img src="/branding/cabify-logo-white-rgb.png" alt="Cabify logo" className="h-8 w-auto sm:h-10" />
              <h1 className="cabify-brand-title text-2xl tracking-tight text-white sm:text-3xl">Brandsafe AI Gen Studio</h1>
            </div>
            <img src="/branding/snippet-logo.png" alt="Snippet logo" className="h-10 w-auto self-start sm:self-auto" />
          </div>
        </header>

        {/* Primary navigation: the funnel is the product, the tools are the workshop. */}
        <section className="panel-surface space-y-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => selectTab('funnel')}
              data-active={activeTab === 'funnel'}
              className="tab-pill"
            >
              <span className="inline-flex items-center gap-1.5"><Workflow className="h-4 w-4" />Ciclo</span>
            </button>
            <button
              type="button"
              onClick={() => selectTab(isToolsSection ? activeTab : 'nano')}
              data-active={isToolsSection}
              className="tab-pill"
            >
              <span className="inline-flex items-center gap-1.5"><Wrench className="h-4 w-4" />Herramientas</span>
            </button>
          </div>

          {isToolsSection && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-700/60 pt-3">
              <div className="flex flex-wrap gap-2">
                {TOOL_ITEMS.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => selectTab(tool.id)}
                    data-active={activeTab === tool.id}
                    className="tab-pill"
                  >
                    <span className="inline-flex items-center gap-1.5">{tool.icon}{tool.label}</span>
                  </button>
                ))}
              </div>

              <div
                role="radiogroup"
                aria-label="Cuenta de Cabify"
                className="flex items-center gap-1 rounded-full border border-slate-700/60 p-1"
              >
                <span className="px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Cuenta</span>
                {CABIFY_ACCOUNTS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="radio"
                    aria-checked={account === entry.id}
                    onClick={() => selectAccount(entry.id)}
                    data-active={account === entry.id}
                    className="tab-pill"
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <main className="space-y-4">
          <section aria-hidden={activeTab !== 'funnel'} className={activeTab === 'funnel' ? 'block' : 'hidden'}>
            <RunFunnelTab isActive={activeTab === 'funnel'} />
          </section>
          <section aria-hidden={activeTab !== 'nano'} className={activeTab === 'nano' ? 'block' : 'hidden'}>
            <NanoEditorTab account={account} />
          </section>
          <section aria-hidden={activeTab !== 'ratio'} className={activeTab === 'ratio' ? 'block' : 'hidden'}>
            <AspectRatioTab account={account} />
          </section>
          <section aria-hidden={activeTab !== 'optimizer'} className={activeTab === 'optimizer' ? 'block' : 'hidden'}>
            <AdOptimizerTab account={account} />
          </section>
          <section aria-hidden={activeTab !== 'library'} className={activeTab === 'library' ? 'block' : 'hidden'}>
            <CreativeLibraryTab />
          </section>
          <section aria-hidden={activeTab !== 'review'} className={activeTab === 'review' ? 'block' : 'hidden'}>
            <ReviewBatchesTab isActive={activeTab === 'review'} />
          </section>
        </main>
      </div>
    </div>
  );
}
