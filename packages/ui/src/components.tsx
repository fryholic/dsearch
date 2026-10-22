import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
export function Button({ primary = false, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; children: ReactNode }) {
  return <button type="button" {...props} className={(primary ? 'button primary' : 'button') + ' ' + className}>{children}</button>;
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) { return <div className={'notice' + (error ? ' error' : '')} role={error ? 'alert' : 'status'}>{children}</div>; }
export function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="empty"><span className="empty-mark" aria-hidden="true">⌕</span><h3>{title}</h3><div className="empty-description">{children}</div></div>; }
export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null), previous = useRef<HTMLElement | null>(null);
  useEffect(() => { previous.current = document.activeElement as HTMLElement;(ref.current?.querySelector<HTMLElement>('input:not(:disabled),textarea:not(:disabled),select:not(:disabled)') ?? ref.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();return () => { if (previous.current?.isConnected) previous.current.focus(); }; }, []);
  return <div className="dialog-backdrop"><section ref={ref} className="dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault();event.stopPropagation();onClose(); }
    if (event.key === 'Tab') { const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') ?? [])];const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault();last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault();first?.focus(); }
    }
  }}><div className="panel-heading"><h2>{title}</h2><Button aria-label="대화상자 닫기" onClick={onClose}>닫기</Button></div>{children}</section></div>;
}
export function SplitPane({ left, right, label = '결과와 원문 패널 너비' }: { left: ReactNode; right: ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null), [ratio, setRatio] = useState(47), cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  const clamp = (value: number) => Math.max(35, Math.min(65, value));
  return <div ref={ref} className="reading-grid split-pane" style={{ gridTemplateColumns: `minmax(0, ${ratio}fr) 16px minmax(0, ${100 - ratio}fr)` }}>{left}<div className="panel-separator" role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={35} aria-valuemax={65} aria-valuenow={Math.round(ratio)} tabIndex={0} onKeyDown={event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault();setRatio(value => clamp(value + (event.key === 'ArrowLeft' ? -2 : 2))); }
    if (event.key === 'Home' || event.key === 'End') { event.preventDefault();setRatio(event.key === 'Home' ? 35 : 65); }
  }} onPointerDown={event => { event.preventDefault();event.currentTarget.focus();cleanup.current();const bounds = ref.current!.getBoundingClientRect();const move = (e: PointerEvent) => setRatio(clamp((e.clientX - bounds.left) * 100 / bounds.width));const stop = () => { document.removeEventListener('pointermove', move);document.removeEventListener('pointerup', stop);document.removeEventListener('pointercancel', stop); };cleanup.current = stop;document.addEventListener('pointermove', move);document.addEventListener('pointerup', stop);document.addEventListener('pointercancel', stop); }}><span aria-hidden="true"/></div>{right}</div>;
}
