import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, Play, Search } from 'lucide-react';
import { fetchAdAccounts, fetchAdCampaigns } from '../../creative-library/services/creativeLibraryApi';
import type { AccountOption, AdsPlatform, CampaignOption } from '../../creative-library/types';
import type { CreativeRun, RunTarget } from '../types';
import { CATEGORY_OPTIONS, getErrorMessage } from '../constants';

interface Step1DetectProps {
  run: CreativeRun | null;
  targets: RunTarget[];
  isBusy: boolean;
  onCreateRun: (input: {
    title: string;
    createdBy: string;
    platform: AdsPlatform;
    accountId: string;
    campaignIds: string[];
    category: string;
    plazas: string[];
    limit: number;
  }) => Promise<void>;
}

const PLATFORMS: Array<{ id: AdsPlatform; label: string }> = [
  { id: 'google', label: 'Google Ads' },
  { id: 'meta', label: 'Meta Ads' },
];

export default function Step1Detect({ run, targets, isBusy, onCreateRun }: Step1DetectProps) {
  const [platform, setPlatform] = useState<AdsPlatform>('google');
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [accountId, setAccountId] = useState('');
  const [campaignIds, setCampaignIds] = useState<string[]>([]);
  const [form, setForm] = useState({ title: '', createdBy: '', category: '', plazas: '', limit: '20' });
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
  const [isLoadingCampaigns, setIsLoadingCampaigns] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (run) return;
    let cancelled = false;
    setIsLoadingAccounts(true);
    setAccountId('');
    setCampaigns([]);
    setCampaignIds([]);
    fetchAdAccounts(platform)
      .then((result) => { if (!cancelled) setAccounts(result); })
      .catch((loadError) => { if (!cancelled) setError(getErrorMessage(loadError)); })
      .finally(() => { if (!cancelled) setIsLoadingAccounts(false); });
    return () => { cancelled = true; };
  }, [platform, run]);

  useEffect(() => {
    if (!accountId || run) return;
    let cancelled = false;
    setIsLoadingCampaigns(true);
    setCampaignIds([]);
    fetchAdCampaigns(platform, accountId)
      .then((result) => { if (!cancelled) setCampaigns(result); })
      .catch((loadError) => { if (!cancelled) setError(getErrorMessage(loadError)); })
      .finally(() => { if (!cancelled) setIsLoadingCampaigns(false); });
    return () => { cancelled = true; };
  }, [platform, accountId, run]);

  const toggleCampaign = (id: string) => {
    setCampaignIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  const plazasList = form.plazas.split(',').map((value) => value.trim()).filter(Boolean);
  const canCreate = Boolean(
    form.title.trim() && form.createdBy.trim() && form.category && plazasList.length > 0
    && accountId && campaignIds.length > 0 && !isBusy,
  );

  const handleCreate = async () => {
    setError(null);
    try {
      await onCreateRun({
        title: form.title.trim(),
        createdBy: form.createdBy.trim(),
        platform,
        accountId,
        campaignIds,
        category: form.category,
        plazas: plazasList,
        limit: Number(form.limit) || 20,
      });
    } catch (createError) {
      setError(getErrorMessage(createError));
    }
  };

  // Once the run exists, step 1 becomes a read-only summary plus the detection results.
  if (run) {
    return (
      <section className="panel-surface space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-white">Paso 1 · Detección de low performers</h3>
          <p className="mt-1 text-sm text-slate-400">
            {run.platform === 'meta' ? 'Meta Ads' : 'Google Ads'} · cuenta {run.accountId} ·{' '}
            {run.campaignIds.length} campaña{run.campaignIds.length !== 1 ? 's' : ''}
          </p>
        </div>

        {targets.length === 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-slate-700/70 bg-slate-900/40 p-4 text-sm text-slate-300">
            <Search className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
            <p>
              {run.status === 'draft'
                ? 'Buscando creativos low performer…'
                : 'No se encontraron creativos low performer con estos filtros. Probá con otras campañas o bajá el mínimo de impresiones.'}
            </p>
          </div>
        )}

        {targets.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-700/70">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Campaña</th>
                  <th className="px-3 py-2 font-medium">Ad group</th>
                  <th className="px-3 py-2 font-medium">Impresiones</th>
                  <th className="px-3 py-2 font-medium">CTR</th>
                  <th className="px-3 py-2 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {targets.map((target) => (
                  <tr key={target.targetId} className="border-t border-slate-800/80">
                    <td className="px-3 py-2 text-slate-200">{target.campaignName || '—'}</td>
                    <td className="px-3 py-2 text-slate-400">{target.adGroupName || '—'}</td>
                    <td className="px-3 py-2 text-slate-400">
                      {(target.metrics.impressions ?? 0).toLocaleString('es-AR')}
                    </td>
                    <td className="px-3 py-2 text-slate-400">
                      {((target.metrics.ctr ?? 0) * 100).toFixed(2)}%
                    </td>
                    <td className="px-3 py-2">
                      <span className="rounded-md bg-slate-800/80 px-2 py-0.5 text-xs text-slate-300">
                        {target.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="panel-surface space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-white">Paso 1 · Nuevo ciclo</h3>
        <p className="mt-1 text-sm text-slate-400">
          Elegí dónde buscar. El ciclo detecta los low performers y genera los reemplazos solo —
          te va a pedir intervención recién en la pre-aprobación.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {PLATFORMS.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setPlatform(option.id)}
            data-active={platform === option.id}
            className="tab-pill"
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm text-slate-200">
          Cuenta
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            disabled={isLoadingAccounts}
            className="mt-1 w-full rounded-xl border border-slate-700/80 bg-slate-900/70 px-4 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-300/70 disabled:opacity-50"
          >
            <option value="">{isLoadingAccounts ? 'Cargando…' : 'Seleccioná una cuenta'}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.label}</option>
            ))}
          </select>
        </label>

        <label className="text-sm text-slate-200">
          Título del ciclo
          <input
            type="text"
            value={form.title}
            onChange={(event) => setForm((previous) => ({ ...previous, title: event.target.value }))}
            placeholder="Ej. Reemplazo octubre · Riders AR"
            className="mt-1 w-full rounded-xl border border-slate-700/80 bg-slate-900/70 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-300/70"
          />
        </label>

        <label className="text-sm text-slate-200">
          Categoría
          <select
            value={form.category}
            onChange={(event) => setForm((previous) => ({ ...previous, category: event.target.value }))}
            className="mt-1 w-full rounded-xl border border-slate-700/80 bg-slate-900/70 px-4 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-300/70"
          >
            <option value="">Seleccioná una categoría</option>
            {CATEGORY_OPTIONS.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
        </label>

        <label className="text-sm text-slate-200">
          Plazas (separadas por comas)
          <input
            type="text"
            value={form.plazas}
            onChange={(event) => setForm((previous) => ({ ...previous, plazas: event.target.value }))}
            placeholder="BUE, CBA"
            className="mt-1 w-full rounded-xl border border-slate-700/80 bg-slate-900/70 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-300/70"
          />
        </label>

        <label className="text-sm text-slate-200">
          Creado por
          <input
            type="text"
            value={form.createdBy}
            onChange={(event) => setForm((previous) => ({ ...previous, createdBy: event.target.value }))}
            placeholder="Nombre o email"
            className="mt-1 w-full rounded-xl border border-slate-700/80 bg-slate-900/70 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-300/70"
          />
        </label>

        <label className="text-sm text-slate-200">
          Máximo de creativos a reemplazar
          <input
            type="number"
            min={1}
            max={100}
            value={form.limit}
            onChange={(event) => setForm((previous) => ({ ...previous, limit: event.target.value }))}
            className="mt-1 w-full rounded-xl border border-slate-700/80 bg-slate-900/70 px-4 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-300/70"
          />
        </label>
      </div>

      {accountId && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-300">
            Campañas {isLoadingCampaigns && <Loader2 className="ml-1 inline h-3.5 w-3.5 animate-spin" />}
          </p>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-slate-700/70 bg-slate-900/40 p-2">
            {campaigns.length === 0 && !isLoadingCampaigns && (
              <p className="px-2 py-1 text-sm text-slate-500">No hay campañas para esta cuenta.</p>
            )}
            {campaigns.map((campaign) => (
              <label
                key={campaign.id}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-300 hover:bg-slate-800/60"
              >
                <input
                  type="checkbox"
                  checked={campaignIds.includes(campaign.id)}
                  onChange={() => toggleCampaign(campaign.id)}
                  className="h-4 w-4 accent-cyan-300"
                />
                {campaign.label}
              </label>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={!canCreate}
          className="inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-2.5 font-semibold text-slate-900 transition-colors hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Iniciar ciclo
        </button>
        <span className="text-xs text-slate-500">
          Al iniciar, el sistema detecta y genera sin pausas hasta la pre-aprobación.
        </span>
      </div>
    </section>
  );
}
