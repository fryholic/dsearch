export type SearchTicket = { id: string | null; generation: number };
/** Both identity and generation must survive an awaited mutation. Also guard rejected requests. */
export async function guardedSearchMutation<T>(captured: SearchTicket, current: () => SearchTicket, operation: () => Promise<T>, apply: (value: T) => void, failed: (error: unknown) => void): Promise<void> {
  const matches = () => { const now = current(); return now.id === captured.id && now.generation === captured.generation; };
  try { const value = await operation(); if (matches()) apply(value); }
  catch (error) { if (matches()) failed(error); }
}
export const normalizedScope = (scope: string, collections: { collection_id: string; enabled: boolean }[]): string => scope === 'all' || collections.some(c => c.collection_id === scope && c.enabled) ? scope : 'all';
