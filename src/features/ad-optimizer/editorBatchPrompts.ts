import type { CabifyAccountId } from '../../../prompts/accounts.js';
import * as corp from '../../../prompts/corp/editorBatch.js';
import * as drivers from '../../../prompts/drivers/editorBatch.js';
import * as riders from '../../../prompts/riders/editorBatch.js';

export interface Scene {
  id: number;
  title: string;
  stage: string;
  scene: string;
  background: string;
  designSpace: string;
}

export interface EditorBatchPrompts {
  constraints: string;
  scenes: Scene[];
}

/** Edited per account in prompts/<account>/editorBatch.js. */
export const EDITOR_BATCH_PROMPTS: Record<CabifyAccountId, EditorBatchPrompts> = {
  riders: { constraints: riders.EDITOR_BATCH_CONSTRAINTS, scenes: riders.EDITOR_BATCH_SCENES },
  drivers: { constraints: drivers.EDITOR_BATCH_CONSTRAINTS, scenes: drivers.EDITOR_BATCH_SCENES },
  corp: { constraints: corp.EDITOR_BATCH_CONSTRAINTS, scenes: corp.EDITOR_BATCH_SCENES },
};
