import { API_VERSION, ErrorEnvelope, DsearchError } from '@dsearch/contracts';
let csrf = '';
export async function api<T = unknown>(method: string, path: string, value?: unknown): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, { method, credentials: 'same-origin', redirect: 'error', headers: { ...(value !== undefined ? { 'content-type': 'application/json' } : {}), ...(!['GET', 'HEAD'].includes(method) ? { 'x-dsearch-csrf': csrf } : {}) }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
    }
    catch {
        throw new DsearchError('SERVICE_UNAVAILABLE');
    }
    let packet: any;
    try {
        packet = await response.json();
    }
    catch {
        throw new DsearchError('COMPATIBILITY_FAILED');
    }
    const error = ErrorEnvelope.safeParse(packet);
    if (error.success)
        throw new DsearchError(error.data.error.code, undefined, false, error.data.error.reason);
    if (!response.ok || packet.schema_version !== API_VERSION || packet.ok !== true)
        throw new DsearchError('COMPATIBILITY_FAILED');
    return packet.data as T;
}
export async function authenticate(): Promise<void> {
    const fragment = location.hash;
    history.replaceState(null, '', location.pathname);
    const match = /^#code=([A-Za-z0-9_-]{43})$/.exec(fragment);
    const result = await api<{
        csrf_token: string;
    }>(match ? 'POST' : 'GET', match ? '/v1/ui/exchange' : '/v1/ui/session', match ? { code: match[1] } : undefined);
    csrf = result.csrf_token;
}
export const message = (error: unknown): string => {
    const code = error instanceof DsearchError ? error.code : 'INTERNAL_ERROR';
    const reasons: Record<string, string> = { RERANK_MODEL_NOT_INSTALLED: '리랭킹 모델이 설치되어 있지 않아요. 모델을 준비하거나 리랭킹을 꺼 주세요.', RERANK_MODEL_UNAVAILABLE: '리랭킹 모델 파일을 검증하지 못했어요. 모델을 다시 준비해 주세요.', RERANK_EXECUTION_FAILED: '리랭킹 실행에 실패했어요. 리랭킹을 끄거나 명시적으로 대체 검색을 허용해 주세요.', EMBED_MODEL_NOT_INSTALLED: '임베딩 모델이 설치되어 있지 않아요. 모델을 준비하거나 키워드 검색을 사용해 주세요.', EMBED_MODEL_UNAVAILABLE: '임베딩 모델 파일을 검증하지 못했어요. 모델을 다시 준비해 주세요.', EXPANSION_MODEL_NOT_INSTALLED: 'Deep 검색의 확장 모델은 아직 설치·활성화되어 있지 않아요.' };
    if (error instanceof DsearchError && error.reason && reasons[error.reason]) return reasons[error.reason]!;
    const messages: Record<string, string> = { UNAUTHORIZED: '연결이 만료되었어요. 터미널에서 pnpm dsearch ui를 실행해 다시 열어 주세요.', SCOPE_DENIED: '사용할 수 없는 문서 범위예요. 컬렉션 등록 상태를 확인해 주세요.', STALE_REVISION: '원문이 변경되었어요. 색인을 다시 만들고 검색해 주세요.', STALE_EPOCH: '색인이 바뀌었어요. 다시 검색해 주세요.', RESULT_EXPIRED: '검색 결과가 만료되었어요. 다시 검색해 주세요.', NO_ACTIVE_GENERATION: '검색할 색인이 아직 없어요. 컬렉션을 등록하고 수동 색인을 시작해 주세요.', SERVICE_UNAVAILABLE: '로컬 서비스에 연결하지 못했어요. 실행 상태를 확인해 주세요.', BUSY: '처리 중인 작업이 있어요. 완료 후 다시 시도해 주세요.', INVALID_REQUEST: '입력값이나 폴더 경로를 확인해 주세요.', SCOPE_INCOMPLETE: '폴더에 접근하지 못했어요. 경로와 접근 권한을 확인해 주세요.', SOURCE_PENDING: '이 원문은 아직 읽을 준비가 되지 않았어요. 색인 상태를 확인해 주세요.', SOURCE_TOO_LARGE: '한 번에 읽을 수 있는 크기를 넘었어요. 더 짧은 구간을 선택해 주세요.', MODEL_NOT_INSTALLED: '필요한 모델 파일이 없어요. 검색 준비에서 다운로드·검증해 주세요.', MODEL_UNAVAILABLE: '모델 무결성 또는 실행을 확인하지 못했어요. 준비 상태를 확인해 주세요.', RERANK_UNAVAILABLE: '리랭킹 모델을 사용할 수 없어요. 리랭킹을 끄거나 대체 검색을 허용해 주세요.', INPUT_TOO_LONG: '모델이 처리할 수 있는 입력 길이를 넘었어요. 검색어를 줄여 주세요.', RESOURCE_EXHAUSTED:'메모리가 부족해 모델 처리를 중단했어요. 다른 작업을 닫고 다시 시도해 주세요.', WORKER_TIMEOUT: '처리 응답이 제한시간 안에 오지 않아 중단했어요. 다시 시도해 주세요.', CANCELLED: '작업을 취소했어요.' };
    return messages[code] ?? '작업을 마치지 못했어요. 오류 코드: ' + code;
};
