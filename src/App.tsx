import React, { useEffect, useState } from 'react';
import { ClipboardCheck, Crop, Library, Sparkles, TrendingDown, Workflow, Wrench } from 'lucide-react';
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

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>(getTabFromLocation);
  const normalizedPath = window.location.pathname.replace(/\/+$/, '') || '/';
  const publicReviewToken = getPublicReviewToken(window.location.pathname, window.location.hash);
  const isPublicReview = normalizedPath === '/review' || normalizedPath === '/r' || normalizedPath.startsWith('/r/');

  useEffect(() => {
    const syncTabFromLocation = () => setActiveTab(getTabFromLocation());
    window.addEventListener('popstate', syncTabFromLocation);
    return () => window.removeEventListener('popstate', syncTabFromLocation);
  }, []);

  const selectTab = (tabId: TabId) => {
    setActiveTab(tabId);
    const url = new URL(window.location.href);
    if (tabId === 'funnel') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tabId);
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
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
            <div className="flex flex-wrap gap-2 border-t border-slate-700/60 pt-3">
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
          )}
        </section>

        <main className="space-y-4">
          <section aria-hidden={activeTab !== 'funnel'} className={activeTab === 'funnel' ? 'block' : 'hidden'}>
            <RunFunnelTab isActive={activeTab === 'funnel'} />
          </section>
          <section aria-hidden={activeTab !== 'nano'} className={activeTab === 'nano' ? 'block' : 'hidden'}>
            <NanoEditorTab />
          </section>
          <section aria-hidden={activeTab !== 'ratio'} className={activeTab === 'ratio' ? 'block' : 'hidden'}>
            <AspectRatioTab />
          </section>
          <section aria-hidden={activeTab !== 'optimizer'} className={activeTab === 'optimizer' ? 'block' : 'hidden'}>
            <AdOptimizerTab />
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
