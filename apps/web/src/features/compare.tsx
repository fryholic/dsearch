import { useEffect, useState, type FormEvent } from 'react';
import type { CollectionInfo } from '@dsearch/contracts/control';
import { Button, Empty, SplitPane, Notice } from '../components.js';
import { api, message } from '../api.js';
import { fromDocument, ReadPanel, SessionState, ExportResults, Processing } from './search.js';
import type { Selection } from './types.js';
import type { SearchSession } from './search-session.js';

export function Comparison({ pins, session, collections, query, setQuery, submit, onRelated, onPin, updatePin, rebuild, find, canRun = true }: {
  pins: Selection[]; session: SearchSession; collections: CollectionInfo[]; query: string; setQuery: (value: string) => void; submit: () => void;
  onRelated: (selection: Selection) => void; onPin: (selection: Selection) => void; updatePin: (selection: Selection) => void; rebuild: () => void; find: () => void; canRun?: boolean;
}) {
  const [left, setLeft] = useState<Selection>(), [right, setRight] = useState<Selection>(), [readVersion, setReadVersion] = useState(0), [error, setError] = useState('');
  const result = session.outcome?.purpose === 'compare' ? session.outcome : undefined, pinsKey = pins.map(p => p.doc_id + p.revision_id).join('|');
  useEffect(() => {
    const select = (index: number, side: 'left' | 'right') => { const pinned = pins[index], group = result?.[side];if (!pinned) return undefined;
      const doc = [...(group?.result.results ?? []), ...(group?.result.supplemental_results ?? [])].find(d => d.doc_id === pinned.doc_id && d.revision_id === pinned.revision_id);return doc ? fromDocument(doc) : pinned;
    };
    setLeft(select(0, 'left'));setRight(select(1, 'right'));
  }, [pinsKey, result?.search_id]);
  useEffect(() => { if (session.state?.state === 'failed') setReadVersion(value => value + 1); }, [session.state?.state]);
  const latest = async (selected: Selection) => { setError('');try { const info = await api<{ doc_id: string; revision_id: string; title: string; relative_path: string; collection_id: string }>('POST', '/v1/documents/info', { doc_id: selected.doc_id });
    updatePin({ ...info, key: info.doc_id + info.revision_id, locator: { kind: 'markdown', start: { line: 1, column_utf16: 0 }, end: { line: 2, column_utf16: 0 } }, heading: [], excerpt: '' });
  } catch (e) { setError(message(e)); } };
  const panel = (side: 'left' | 'right', index: number, selected: Selection | undefined, select: (value: Selection | undefined) => void) => {
    const pinned = pins[index], group = result?.[side], documents = group ? [...group.result.results, ...group.result.supplemental_results] : [], doc = documents.find(d => d.doc_id === pinned?.doc_id && d.revision_id === pinned?.revision_id);
    return <div className="comparison-side"><div className="management-actions">{pinned ? <><Button onClick={() => onPin(pinned)}>이 문서 비교 해제</Button><Button onClick={() => void latest(pinned)}>최신 revision으로 선택</Button></> : <Button onClick={find}>검색에서 문서 선택</Button>}</div>{group && pinned && group.source.doc_id === pinned.doc_id && group.source.revision_id === pinned.revision_id ? <><Processing result={group.result}/>{doc?.evidence.length && doc.evidence.length > 1 ? <div className="management-actions">{doc.evidence.map((e, i) => <Button key={e.passage_id} onClick={() => select(fromDocument(doc, i))}>근거 {i + 1} · L{e.locator.start.line}</Button>)}</div> : !doc ? <p className="hint">이 질의에 맞는 근거가 없어요. 선택한 원래 구간을 읽을 수 있어요.</p> : null}</> : null}<ReadPanel selected={selected} collections={collections} onRelated={onRelated} onPin={onPin} onClose={() => select(undefined)} rebuild={rebuild} heading={side === 'left' ? '왼쪽 원문' : '오른쪽 원문'} pinned={!!pinned} checkVersion={readVersion}/></div>;
  };
  const form = (event: FormEvent) => { event.preventDefault();submit(); };
  return <>{error ? <Notice error>{error}</Notice> : null}<form className="search-form" onSubmit={form}><label htmlFor="compare-query">비교할 질문</label><div className="search-input"><input id="compare-query" value={query} onChange={e => setQuery(e.target.value)} maxLength={8192} placeholder="예: 공유 비밀과 서명 검증에 쓰이는 키의 차이" autoComplete="off"/>{session.busy ? <Button onClick={() => void session.cancel()}>취소</Button> : <Button primary type="submit" disabled={!canRun || pins.length !== 2 || !query.trim()}>양쪽 근거 찾기</Button>}</div></form>{result && result.left.result.query_plan.query !== query ? <Notice>표시된 근거는 이전 비교 질문의 결과예요.</Notice> : null}<p className="hint">선택한 두 문서는 새 검색으로 바뀌지 않아요. 양쪽 revision과 근거를 각각 확인해요.</p>{pins.length !== 2 ? <Empty title="비교할 문서 두 개를 골라 주세요">검색 결과나 원문에서 ‘비교에 담기’를 선택하세요. <Button onClick={find}>문서 검색으로 이동</Button></Empty> : null}<SessionState session={session}/><ExportResults session={session}/><div className="comparison-workspace"><SplitPane label="비교 원문 너비" left={panel('left', 0, left, setLeft)} right={panel('right', 1, right, setRight)}/></div></>;
}
