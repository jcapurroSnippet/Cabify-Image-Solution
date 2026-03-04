import React, { useState } from 'react';
import { Crop, Sparkles } from 'lucide-react';
import AspectRatioTab from './features/aspect-ratio/AspectRatioTab';
import NanoEditorTab from './features/nano-editor/NanoEditorTab';

type TabId = 'nano' | 'ratio';

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
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('nano');

  return (
    <div className="min-h-screen px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <header className="panel-surface">
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Cabify Image Suite</h1>
          <p className="mt-1 inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-slate-400">
            <img src="/snippet.ico" alt="Snippet icon" className="h-4 w-4 rounded-sm" />
            By Snippet
          </p>
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
        </main>
      </div>
    </div>
  );
}
