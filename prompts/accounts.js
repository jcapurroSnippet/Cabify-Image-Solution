/**
 * The Cabify accounts the studio generates for. Each one owns a complete copy
 * of the prompts under prompts/<id>/, so an account's wording can change
 * without touching the others. Riders is the account they were written for.
 *
 * Shared by the browser (the selector) and the server (request validation),
 * which is why it lives outside both src/ and server/.
 */

/** @typedef {'riders' | 'drivers' | 'corp'} CabifyAccountId */

/** @type {ReadonlyArray<{ id: CabifyAccountId, label: string }>} */
export const CABIFY_ACCOUNTS = Object.freeze([
  { id: 'riders', label: 'Riders' },
  { id: 'drivers', label: 'Drivers' },
  { id: 'corp', label: 'Corp' },
]);

/** @type {CabifyAccountId} */
export const DEFAULT_CABIFY_ACCOUNT = 'riders';

/**
 * A missing account means Riders, so callers that predate the selector keep
 * their behaviour. An unrecognised one returns null instead of falling back:
 * silently generating with another account's prompts is worse than failing.
 *
 * @param {unknown} value
 * @returns {CabifyAccountId | null}
 */
export const normalizeCabifyAccount = (value) => {
  const id = String(value ?? '').trim().toLowerCase();
  if (!id) return DEFAULT_CABIFY_ACCOUNT;
  const account = CABIFY_ACCOUNTS.find((entry) => entry.id === id);
  return account ? account.id : null;
};
