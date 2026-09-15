import { DEFAULT_CABIFY_ACCOUNT } from './accounts.js';
import * as ridersAspectRatio from './riders/aspectRatio.js';
import * as ridersNanoEditor from './riders/nanoEditor.js';
import * as driversAspectRatio from './drivers/aspectRatio.js';
import * as driversNanoEditor from './drivers/nanoEditor.js';
import * as corpAspectRatio from './corp/aspectRatio.js';
import * as corpNanoEditor from './corp/nanoEditor.js';

/**
 * Server-side prompts per account. Editor Batch is not listed: its scenes and
 * constraints are built in the browser, which imports prompts/<id>/editorBatch.js
 * directly so these server prompts never reach the client bundle.
 */
const ACCOUNT_PROMPTS = {
  riders: { aspectRatio: ridersAspectRatio, nanoEditor: ridersNanoEditor },
  drivers: { aspectRatio: driversAspectRatio, nanoEditor: driversNanoEditor },
  corp: { aspectRatio: corpAspectRatio, nanoEditor: corpNanoEditor },
};

export const getAccountPrompts = (account) => {
  const id = account || DEFAULT_CABIFY_ACCOUNT;
  if (!Object.hasOwn(ACCOUNT_PROMPTS, id)) throw new Error(`Unknown Cabify account "${account}".`);
  return ACCOUNT_PROMPTS[id];
};
