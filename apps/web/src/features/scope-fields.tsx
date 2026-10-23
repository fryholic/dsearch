import { CollectionMetadataFilter, CollectionRequest } from '@dsearch/contracts';
import type { CollectionInfo } from '@dsearch/contracts/control';

export type ScopeDraft = { include: string; exclude: string; prefixes: string; metadata: string; headings: string };
export const scopeDraft = (c?: CollectionInfo): ScopeDraft => ({ include: (c?.include ?? ['**/*.md','**/*.markdown']).join('\n'), exclude: (c?.exclude ?? []).join('\n'), prefixes: (c?.path_prefixes ?? []).join('\n'), metadata: c?.metadata_filter ? JSON.stringify(c.metadata_filter, null, 2) : '', headings: (c?.navigation_headings ?? []).join('\n') });
const lines = (value: string) => value.split('\n').map(v => v.trim()).filter(Boolean);
export function scopeRules(draft: ScopeDraft) {
  const filter = draft.metadata.trim() ? CollectionMetadataFilter.parse(JSON.parse(draft.metadata)) : null;
  return { include: lines(draft.include), exclude: lines(draft.exclude), path_prefixes: lines(draft.prefixes), metadata_filter: filter, navigation_headings: lines(draft.headings) };
}
export function ScopeFields({ value, change }: { value: ScopeDraft; change: (value: ScopeDraft) => void }) {
  const set = (key: keyof ScopeDraft, text: string) => change({ ...value, [key]: text });
  let issues: string[] = [];
  try { const checked = CollectionRequest.safeParse({ name: 'Scope', root: '/', ...scopeRules(value) });if (!checked.success) issues = checked.error.issues.map(issue => String(issue.path[0])); } catch { issues = ['metadata_filter']; }
  const invalid = issues.includes('metadata_filter');
  return <details className="scope-rules"><summary>포함·제외 규칙</summary>
    <label>포함 · 한 줄에 하나<textarea rows={3} value={value.include} onChange={e => set('include', e.target.value)}/></label>
    <label>제외 · 한 줄에 하나<textarea rows={3} value={value.exclude} onChange={e => set('exclude', e.target.value)}/></label>
    <label>하위 폴더 범위 · 선택<textarea rows={2} value={value.prefixes} onChange={e => set('prefixes', e.target.value)} placeholder="Projects/"/></label><p className="hint">비워 두면 모든 하위 폴더를 확인해요. 제한하려면 등록 폴더 기준 경로를 /로 끝내어 한 줄씩 입력하세요.</p>
    {issues.includes('path_prefixes') ? <p role="alert" className="error-text">하위 폴더는 상대 경로를 /로 끝내어 입력하세요. .. · 절대 경로 · glob 기호는 사용할 수 없어요.</p> : null}
    {issues.some(key => ['include','exclude'].includes(key)) ? <p role="alert" className="error-text">포함 패턴을 하나 이상 입력하고 패턴의 길이와 개수를 확인하세요.</p> : null}
    <label>메타데이터 조건 · JSON · 선택<textarea rows={4} maxLength={16384} value={value.metadata} onChange={e => set('metadata', e.target.value)} spellCheck={false}/></label><p className="hint">비워 두면 메타데이터를 요구하지 않아요. 예: {JSON.stringify({not:{field:'metadata.status',operator:'eq',value:'draft'}})} — draft 상태만 제외해요. eq·ne는 단일 값, in·all은 목록, exists는 true·false를 사용해요.</p>
    {invalid ? <p role="alert" className="error-text">메타데이터 조건의 JSON 형식과 필드·연산자를 확인하세요.</p> : null}
    <label>색인에서 제외할 제목 · 선택<textarea rows={2} value={value.headings} onChange={e => set('headings', e.target.value)}/></label><p className="hint">제목과 정확히 일치하는 구간의 본문을 검색에서 제외해요. 비워 두면 제목에 따른 제외는 없어요.</p>
    {issues.includes('navigation_headings') ? <p role="alert" className="error-text">제목은 각각 256자 이하, 최대 64개까지 입력할 수 있어요.</p> : null}
  </details>;
}
export const eligibilityLabel = (code: string) => ({ eligible:'포함', excluded_pattern:'경로 규칙으로 제외', excluded_metadata:'메타데이터 조건으로 제외', excluded_role:'이전 역할 규칙으로 제외', excluded_status:'이전 상태 규칙으로 제외', excluded_source:'파일 종류·범위로 제외', invalid_metadata:'메타데이터 구문 확인 필요', unreadable:'읽기 권한 확인 필요', unsupported_encoding:'지원하지 않는 문자 인코딩', pending:'다시 확인 필요', deleted:'파일이 없음' }[code] ?? '처리 상태 확인 필요');
export const reasonLabel = (code: string | null) => ({ eligible:'규칙에 일치해요', include_pattern:'포함 패턴에 일치하지 않아요', exclude_pattern:'제외 패턴에 일치해요', outside_path_prefixes:'설정한 하위 폴더 범위 밖이에요', metadata_condition:'메타데이터 조건에 일치하지 않아요', metadata_partial:'본문은 포함하며 일부 메타데이터는 필터에 사용할 수 없어요', outside_learning_scope:'이전 버전의 경로 제한에 해당해요', learning_role:'이전 버전의 역할 제한에 해당해요', superseded:'이전 버전의 상태 제한에 해당해요', source_directory:'이전 버전의 폴더 제외 규칙에 해당해요', source_role:'이전 버전의 역할 제외 규칙에 해당해요', hidden_path:'숨김 경로예요', dependency_directory:'의존성 폴더예요', symlink:'심볼릭 링크는 따라가지 않아요', invalid_metadata:'YAML 문법·중복 키·파싱 한도를 확인하세요', unsupported_encoding:'UTF-8 문서가 아니에요', product_data:'앱 데이터 폴더예요' }[code ?? 'eligible'] ?? '상세 진단 코드에서 이유를 확인하세요');
