import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle, Image as ImageIcon, Loader2, SkipForward } from 'lucide-react';
import type { CreativeRun, RunGenerationEvent, RunTarget } from '../types';

interface Step2GenerateProps {
  run: CreativeRun;
  targets: RunTarget[];
  isGenerating: boolean;
  events: RunGenerationEvent[];
}

const TARGET_STATUS_STYLES: Record<string, { icon: ReactNode; className: string; label: string }> = {
  generated: {
    icon: <CheckCircle className="h-4 w-4 text-green-400" />,
    className: 'border-green-500/30 bg-green-500/5',
    label: 'Generado',
  },
  no_source: {
    icon: <SkipForward className="h-4 w-4 text-amber-300" />,
    className: 'border-amber-500/40 bg-amber-500/10',
    label: 'Sin imagen fuente',
  },
  failed: {
    icon: <AlertCircle className="h-4 w-4 text-red-400" />,
    className: 'border-red-500/30 bg-red-500/10',
    label: 'Falló',
  },
  approved: {
    icon: <CheckCircle className="h-4 w-4 text-cyan-300" />,
    className: 'border-cyan-300/40 bg-cyan-300/10',
    label: 'Aprobado',
  },
  replaced: {
    icon: <CheckCircle className="h-4 w-4 text-cyan-300" />,
    className: 'border-cyan-300/40 bg-cyan-300/10',
    label: 'Reemplazado',
  },
};

const SOURCE_ORIGIN_LABELS: Record<string, string> = {
  low_performer: 'imagen del low performer',
  bank: 'banco de Drive',
};

export default function Step2Generate({ run, targets, isGenerating, events }: Step2GenerateProps) {
  const done = targets.filter((target) => target.status !== 'detected' && target.status !== 'generating').length;
  const percentage = targets.length > 0 ? Math.round((done / targets.length) * 100) : 0;
  const lastEvent = events[events.length - 1];

  return (
    <section className="panel-surface space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-white">Paso 2 · Generación de piezas</h3>
          <p className="mt-1 text-sm text-slate-400">
            Tres variantes en cada uno de los 3 ratios (1:1, 9:16, 1.91:1) por cada creativo detectado.
          </p>
        </div>
        {isGenerating && (
          <span className="inline-flex items-center gap-2 rounded-full border border-cyan-200/30 bg-cyan-300/10 px-3 py-1 text-xs text-cyan-100">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {done} / {targets.length}
          </span>
        )}
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800/80">
        <div
          className="h-full rounded-full bg-cyan-300 transition-all duration-500"
          style={{ width: `${percentage}%` }}
        />
      </div>

      {isGenerating && lastEvent && (
        <p className="text-xs text-slate-400">
          {lastEvent.state === 'ratio_done' && `Ratio ${lastEvent.ratio} listo (${lastEvent.variants} variantes)…`}
          {lastEvent.state === 'target_started' && `Procesando creativo ${lastEvent.index} de ${lastEvent.pending}…`}
          {lastEvent.state === 'keepalive' && 'Generando…'}
          {lastEvent.state === 'target_skipped' && `Salteado: ${lastEvent.reason}`}
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {targets.map((target) => {
          const style = TARGET_STATUS_STYLES[target.status];
          const isActive = target.status === 'generating' || (isGenerating && target.status === 'detected');
          return (
            <div
              key={target.targetId}
              className={`flex items-start gap-3 rounded-xl border p-3 ${
                style?.className || 'border-slate-700/70 bg-slate-900/40'
              }`}
            >
              <div className="mt-0.5 shrink-0">
                {isActive ? <Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> : (style?.icon
                  ?? <ImageIcon className="h-4 w-4 text-slate-500" />)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-200">
                  {target.campaignName || target.targetId}
                </p>
                <p className="truncate text-xs text-slate-500">{target.adGroupName || '—'}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {isActive ? 'Generando…' : style?.label || 'En cola'}
                  {target.sourceImageOrigin && ` · fuente: ${
                    SOURCE_ORIGIN_LABELS[target.sourceImageOrigin] || target.sourceImageOrigin
                  }`}
                </p>
                {target.error && (
                  <p className="mt-1 break-words text-xs text-red-300">{target.error}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!isGenerating && run.summary.generated > 0 && (
        <p className="text-sm text-slate-300">
          {run.summary.generated} creativo{run.summary.generated !== 1 ? 's' : ''} con piezas listas para revisar.
        </p>
      )}
    </section>
  );
}
