import { useEffect, useRef, useState } from 'react';
import { DsearchError } from '@dsearch/contracts';
import { SearchAccepted } from '@dsearch/contracts/client';
import { SearchStatus, type SearchComplete } from '@dsearch/contracts/search';
import { api, message } from '../api.js';
import { guardedSearchMutation } from '../search-state.js';
export const isWorking = (state?: string) => !!state && ['queued', 'running', 'cancel_requested'].includes(state);

/** RAM-only session. Both SSE and polling share the same ID and request-generation guard. */
export function useSearchSession(scopeKey: string, onComplete: () => void) {
  const [state, setState] = useState<SearchStatus>(), [outcome, setOutcome] = useState<SearchComplete>(), [error, setError] = useState('');
  const sequence = useRef(0), current = useRef<string | null>(null), pendingCancel = useRef(false), stream = useRef<EventSource | null>(null), alive = useRef(true), stateRef = useRef(state), completed = useRef(onComplete);
  stateRef.current = state;completed.current = onComplete;
  const stop = (clear = true) => {
    sequence.current++;stream.current?.close();stream.current = null;
    const id = current.current;current.current = null;pendingCancel.current = false;
    if (id && isWorking(stateRef.current?.state)) void api('DELETE', '/v1/searches/' + id).catch(() => {});
    if (alive.current) setState(undefined);if (clear) { setOutcome(undefined);setError(''); }
  };
  useEffect(() => { stop(); }, [scopeKey]);
  useEffect(() => { alive.current = true;return () => { alive.current = false;stop(false); }; }, []);
  const run = async (path: string, body: unknown) => {
    stop(false);const ticket = sequence.current;setError('');setState({ search_id: 'starting', state: 'queued', phase: 'queued' });
    const valid = () => alive.current && ticket === sequence.current;
    try {
      const accepted = SearchAccepted.parse(await api('POST', path, body));
      if (!valid()) { void api('DELETE', accepted.status_url).catch(() => {});return; }
      current.current = accepted.search_id;
      const apply = (input: unknown) => {
        if (!valid() || current.current !== accepted.search_id) return false;
        const parsed = SearchStatus.parse(input);if (parsed.search_id !== accepted.search_id) throw new DsearchError('COMPATIBILITY_FAILED');setState(parsed);
        if (parsed.state === 'completed') { setOutcome(parsed);stream.current?.close();completed.current();return false; }
        if (parsed.state === 'failed' || parsed.state === 'cancelled') { stream.current?.close();if (parsed.state === 'failed') setError(message(new DsearchError(parsed.error?.code ?? 'INTERNAL_ERROR', undefined, false, parsed.error?.reason)));return false; }
        return true;
      };
      if (pendingCancel.current) { if (!apply(await api('DELETE', accepted.status_url)) || !valid()) return; }
      const events = new EventSource(accepted.events_url);stream.current = events;
      events.addEventListener('state', event => { try { const packet = JSON.parse((event as MessageEvent).data);if (packet.schema_version !== 1 || !packet.ok) throw new DsearchError('COMPATIBILITY_FAILED');apply(packet.data); }
        catch (e) { events.close();if (valid()) { setState(undefined);setError(message(e)); } } });
      events.onerror = () => { events.close();void (async () => {
        try { while (valid() && apply(await api('GET', accepted.status_url))) await new Promise(resolve => setTimeout(resolve, 150)); }
        catch (e) { if (valid()) { setState(undefined);setError(message(e)); } }
      })(); };
    } catch (e) { if (valid()) { setState(undefined);setError(message(e)); } }
  };
  const cancel = async () => {
    if (!current.current) { pendingCancel.current = true;setState({ search_id: 'starting', state: 'cancel_requested', phase: 'cancel-requested' });return; }
    const capture = { id: current.current, generation: sequence.current };
    await guardedSearchMutation(capture, () => ({ id: current.current, generation: sequence.current }), () => api('DELETE', '/v1/searches/' + capture.id), value => setState(SearchStatus.parse(value)), e => setError(message(e)));
  };
  return { state, outcome, error, run, cancel, reset: stop, busy: isWorking(state?.state) };
}
export type SearchSession = ReturnType<typeof useSearchSession>;
