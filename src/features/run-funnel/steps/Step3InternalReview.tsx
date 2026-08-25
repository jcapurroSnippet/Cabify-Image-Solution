import { useState } from 'react';
import { AlertCircle, ArrowRight, Loader2, ShieldCheck } from 'lucide-react';
import CreativeReviewPortal from '../../creative-review/CreativeReviewPortal';
import type { CreativeRun } from '../types';
import { getErrorMessage } from '../constants';

interface Step3InternalReviewProps {
  run: CreativeRun;
  onSubmitForClientReview: () => Promise<void>;
}

/**
 * Snippet's pre-approval gate. The existing review portal is reused as-is for
 * the grid; the only thing this step adds is the hand-off button that mints the
 * client link and moves the run to step 4.
 */
export default function Step3InternalReview({ run, onSubmitForClientReview }: Step3InternalReviewProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await onSubmitForClientReview();
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="panel-surface space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-white">Paso 3 · Pre-aprobación Snippet</h3>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Revisá las piezas generadas y descartá las que no van a mostrarse al cliente.
              Lo que quede es exactamente lo que Cabify va a ver.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSubmitting}
            className="inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-2.5 font-semibold text-slate-900 transition-colors hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            Mandar a aprobar a Cabify
          </button>
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-slate-700/70 bg-slate-900/40 p-3 text-sm text-slate-300">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
          <p>
            Al mandarlas a aprobar se genera un enlace privado con vencimiento a 30 días.
            Después de ese punto las piezas quedan bloqueadas para edición interna.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}
      </section>

      {run.reviewBatchId && (
        <CreativeReviewPortal embedded batchId={run.reviewBatchId} sheetsUrl={run.sheetsUrl} />
      )}
    </div>
  );
}
