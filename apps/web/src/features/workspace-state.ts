import { DsearchError } from '@dsearch/contracts';
import { ModelInfo } from '@dsearch/contracts/control';

/** Model storage can need repair while the catalog and lexical index remain usable. */
export async function loadModelInventory(read: () => Promise<unknown>): Promise<{ models: ModelInfo[]; unavailable: boolean }> {
  try { return { models: ModelInfo.array().parse(await read()), unavailable: false }; }
  catch (error) {
    if (error instanceof DsearchError && error.code === 'UNAUTHORIZED') throw error;
    return { models: [], unavailable: true };
  }
}
