import React, { useState } from 'react';
import { Crop, Sparkles, TrendingDown } from 'lucide-react';
import AspectRatioTab from './features/aspect-ratio/AspectRatioTab';
import NanoEditorTab from './features/nano-editor/NanoEditorTab';
import AdOptimizerTab from './features/ad-optimizer/AdOptimizerTab';

type TabId = 'nano' | 'ratio' | 'optimizer';

const TAB_ITEMS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
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
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('nano');

  return (
    <div className="min-h-screen px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <header className="panel-surface">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3 sm:gap-4">
              <img src="/branding/cabify-logo-white-rgb.png" alt="Cabify logo" className="h-8 w-auto sm:h-10" />
              <h1 className="cabify-brand-title text-2xl tracking-tight text-white sm:text-3xl">Brandsafe AI Gen Studio</h1>
            </div>
            <img src="/branding/snippet-logo.png" alt="Snippet logo" className="h-10 w-auto self-start sm:self-auto" />
          </div>
        </header>

        <section className="panel-surface">
          <div className="flex flex-wrap gap-2">
            {TAB_ITEMS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                data-active={activeTab === tab.id}
                className="tab-pill"
              >
                <span className="inline-flex items-center gap-1.5">{tab.icon}{tab.label}</span>
              </button>
            ))}
          </div>
        </section>

        <main className="space-y-4">
          <section aria-hidden={activeTab !== 'nano'} className={activeTab === 'nano' ? 'block' : 'hidden'}>
            <NanoEditorTab />
          </section>
          <section aria-hidden={activeTab !== 'ratio'} className={activeTab === 'ratio' ? 'block' : 'hidden'}>
            <AspectRatioTab />
          </section>
          <section aria-hidden={activeTab !== 'optimizer'} className={activeTab === 'optimizer' ? 'block' : 'hidden'}>
            <AdOptimizerTab />
          </section>
        </main>
      </div>
    </div>
  );
}
