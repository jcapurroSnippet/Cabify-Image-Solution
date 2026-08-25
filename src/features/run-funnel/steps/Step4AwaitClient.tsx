import { useMemo, useState } from 'react';
import { AlertCircle, Check, Copy, ExternalLink, Loader2, MailCheck, RefreshCw, Send } from 'lucide-react';
import type { CreativeRun } from '../types';
import { formatDateTime, getErrorMessage } from '../constants';

interface Step4AwaitClientProps {
  run: CreativeRun;
  onMarkSent: () => Promise<void>;
  onSync: () => Promise<void>;
  isSyncing: boolean;
}

const toAbsoluteUrl = (url: string) => {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`;
};

export default function Step4AwaitClient({ run, onMarkSent, onSync, isSyncing }: Step4AwaitClientProps) {
  const [copied, setCopied] = useState<'link' | 'message' | null>(null);
  const [isMarking, setIsMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const absoluteUrl = toAbsoluteUrl(run.privateUrl);
  const hasBeenSent = run.status === 'client_review';

  // The funnel does not send mail. It hands over a ready-to-paste message so
  // the person asking for approval does not have to write one.
  const message = useMemo(() => [
    `Asunto: Aprobación de creativos — ${run.title}`,
    '',
    'Hola,',
    '',
    `Te comparto la tanda de creativos "${run.title}" para tu aprobación.`,
    `Categoría: ${run.category}${run.plazas.length ? ` · Plazas: ${run.plazas.join(', ')}` : ''}`,
    '',
    `Enlace de revisión: ${absoluteUrl}`,
    '',
    'Podés aprobar o rechazar cada pieza desde el enlace. El acceso vence a los 30 días.',
    '',
    'Gracias!',
  ].join('\n'), [run.title, run.category, run.plazas, absoluteUrl]);

  const copy = async (value: string, kind: 'link' | 'message') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1800);
    } catch {
      setError('No se pudo copiar. Seleccioná el texto y copialo a mano.');
    }
  };

  const handleMarkSent = async () => {
    setIsMarking(true);
    setError(null);
    try {
      await onMarkSent();
    } catch (markError) {
      setError(getErrorMessage(markError));
    } finally {
      setIsMarking(false);
    }
  };

  return (
    <section className="panel-surface space-y-4">
      {/* The banner is the whole point of step 4: make it unmissable that the
          funnel is now blocked on a human asking Cabify for approval. */}
      <div className={`rounded-2xl border p-5 ${
        hasBeenSent ? 'border-cyan-200/40 bg-cyan-300/10' : 'border-amber-500/40 bg-amber-500/10'
      }`}>
        <div className="flex items-start gap-3">
          {hasBeenSent
            ? <MailCheck className="mt-0.5 h-6 w-6 shrink-0 text-cyan-300" />
            : <Send className="mt-0.5 h-6 w-6 shrink-0 text-amber-300" />}
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold text-white">
              {hasBeenSent
                ? 'Esperando la aprobación de Cabify'
                : 'Falta pedirle la aprobación a Cabify'}
            </h3>
            <p className={`mt-1 text-sm ${hasBeenSent ? 'text-cyan-100' : 'text-amber-100'}`}>
              {hasBeenSent
                ? `Enviado el ${formatDateTime(run.sentAt)}. Cuando Cabify termine de aprobar, actualizá para continuar al Paso 5.`
                : 'El sistema no manda mails. Copiá el enlace o el mensaje de abajo, mandáselo a Cabify y marcá el envío.'}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-slate-300">Enlace privado de revisión</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            readOnly
            value={absoluteUrl}
            className="flex-1 rounded-xl border border-slate-700/80 bg-slate-900/70 px-4 py-2.5 font-mono text-xs text-slate-200 outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void copy(absoluteUrl, 'link')}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700/80 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
            >
              {copied === 'link' ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
              Copiar
            </button>
            <a
              href={absoluteUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700/80 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
            >
              <ExternalLink className="h-4 w-4" />
              Abrir
            </a>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-300">Mensaje listo para enviar</p>
          <button
            type="button"
            onClick={() => void copy(message, 'message')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/80 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
          >
            {copied === 'message' ? <Check className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
            Copiar mensaje
          </button>
        </div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-slate-700/70 bg-slate-900/40 p-4 text-xs leading-relaxed text-slate-300">
          {message}
        </pre>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {!hasBeenSent && (
          <button
            type="button"
            onClick={() => void handleMarkSent()}
            disabled={isMarking}
            className="inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-2.5 font-semibold text-slate-900 transition-colors hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {isMarking ? <Loader2 className="h-4 w-4 animate-spin" /> : <MailCheck className="h-4 w-4" />}
            Ya se lo mandé a Cabify
          </button>
        )}
        {hasBeenSent && (
          <button
            type="button"
            onClick={() => void onSync()}
            disabled={isSyncing}
            className="inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-2.5 font-semibold text-slate-900 transition-colors hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {isSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Revisar si ya aprobaron
          </button>
        )}
        <span className="text-xs text-slate-500">
          {run.approvedCount > 0 && `${run.approvedCount} creativo${run.approvedCount !== 1 ? 's' : ''} aprobado${run.approvedCount !== 1 ? 's' : ''}.`}
        </span>
      </div>
    </section>
  );
}
