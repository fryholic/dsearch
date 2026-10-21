import type { ButtonHTMLAttributes, ReactNode } from 'react';
export function Button({ primary = false, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
    primary?: boolean;
    children: ReactNode;
}) { return <button {...props} className={(primary ? 'button primary' : 'button') + ' ' + className}>{children}</button>; }
export function Notice({ children, error = false }: {
    children: ReactNode;
    error?: boolean;
}) { return <div className={'notice' + (error ? ' error' : '')} role={error ? 'alert' : 'status'}>{children}</div>; }
export function Empty({ title, children }: {
    title: string;
    children: ReactNode;
}) { return <div className="empty"><span className="empty-mark" aria-hidden="true">⌕</span><h3>{title}</h3><p>{children}</p></div>; }
export const phaseLabel = (value: string) => ({ queued: '대기 중', running: '진행 중', loading: '검색 엔진 준비 중', searching: '키워드 검색 중', 'literal-scanning': '원문에서 문자열을 찾는 중', scanning: '원문 확인 중', reconciling: '원문 대조 중', indexing: '키워드 색인 구성 중', sealing: '색인 무결성 검증 중', complete: '완료', compiling: '문서 구간 구성 중', embedding: '검색 자료 준비 중', validating: '원문 위치 검증 중', publishing: '색인 게시 중', succeeded: '완료', failed: '실패', obsolete: '원문 변경으로 중단', cancelled: '취소됨', cancel_requested: '멈추는 중', 'cancel-requested': '멈추는 중' }[value] ?? value);
