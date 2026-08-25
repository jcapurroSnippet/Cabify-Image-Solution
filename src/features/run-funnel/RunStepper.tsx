import { Check, Loader2 } from 'lucide-react';
import { FUNNEL_STEPS } from './constants';

interface RunStepperProps {
  currentStep: number;
  busyStep?: number | null;
  failed?: boolean;
}

/**
 * The funnel spine. Everything the user sees hangs off which step they are in,
 * so the stepper is the one element that is always on screen.
 */
export default function RunStepper({ currentStep, busyStep = null, failed = false }: RunStepperProps) {
  return (
    <ol className="flex flex-wrap items-stretch gap-2">
      {FUNNEL_STEPS.map(({ step, label, hint }) => {
        const isDone = !failed && step < currentStep;
        const isCurrent = step === currentStep;
        const isBusy = busyStep === step;

        return (
          <li
            key={step}
            className={`flex min-w-[9.5rem] flex-1 flex-col gap-1 rounded-xl border px-3 py-2.5 transition-colors ${
              isCurrent && failed
                ? 'border-red-500/40 bg-red-500/10'
                : isCurrent
                  ? 'border-cyan-300/70 bg-cyan-300/10'
                  : isDone
                    ? 'border-slate-600/60 bg-slate-900/40'
                    : 'border-slate-700/70 bg-slate-900/25'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  isDone
                    ? 'bg-cyan-300/20 text-cyan-100'
                    : isCurrent
                      ? 'bg-cyan-300 text-slate-950'
                      : 'bg-slate-800/80 text-slate-400'
                }`}
              >
                {isBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : isDone ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  step
                )}
              </span>
              <span className={`text-sm font-semibold ${isCurrent || isDone ? 'text-white' : 'text-slate-400'}`}>
                {label}
              </span>
            </div>
            <span className="text-xs leading-snug text-slate-500">{hint}</span>
          </li>
        );
      })}
    </ol>
  );
}
