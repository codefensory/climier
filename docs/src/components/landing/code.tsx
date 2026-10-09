import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { CheckIcon, CopyIcon } from './icons';

/**
 * Half-open marker used in every specimen excerpt: the landing prints the real
 * key names and the real values, and marks the fields it elided instead of
 * inventing a prettier shape than the command returns.
 */
const ELISION = '…';

/**
 * Tokens the JSON highlighter colors: a quoted key, a quoted value, a number,
 * an elision, or a punctuation run.
 */
const TOKEN = /"(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*"|\b\d+\b|…|[:{}[\],]+/g;

function tokenClass(token: string): string {
  if (token === ELISION) return 'text-fd-muted-foreground/45';
  if (token.endsWith(':')) return 'text-fd-foreground';
  if (token.startsWith('"')) return 'text-brand';
  if (/^\d/.test(token)) return 'text-fd-foreground tabular-nums';
  return 'text-fd-muted-foreground/70';
}

/** Renders one line of JSON output with keys, values, and punctuation told apart. */
export function JsonLine({ line }: { line: string }) {
  const parts: ReactNode[] = [];
  let cursor = 0;

  for (const match of line.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > cursor) parts.push(line.slice(cursor, at));
    parts.push(
      <span key={`${at}-${match[0]}`} className={tokenClass(match[0])}>
        {match[0]}
      </span>,
    );
    cursor = at + match[0].length;
  }

  if (cursor < line.length) parts.push(line.slice(cursor));
  return <>{parts}</>;
}

type CopyState = 'idle' | 'copied' | 'error';

const COPY_LABEL: Record<CopyState, string> = {
  idle: 'Copy',
  copied: 'Copied',
  error: 'Copy failed',
};

/**
 * Copy control for a command block. Clipboard access can be denied by the
 * browser, so a failed write is reported instead of silently doing nothing.
 */
export function CopyButton({ value, label, className = '' }: { value: string; label: string; className?: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    let next: CopyState = 'copied';
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      next = 'error';
    }

    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={state === 'idle' ? label : COPY_LABEL[state]}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors ${
        state === 'error' ? 'text-fd-error' : 'text-fd-muted-foreground hover:text-fd-foreground'
      } focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${className}`}
    >
      {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite">{COPY_LABEL[state]}</span>
    </button>
  );
}

/** Frame shared by the graph console, the transcript, and the specimen panels. */
export function Panel({
  children,
  className = '',
  as: Tag = 'div',
  ref,
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'figure';
  ref?: Ref<HTMLElement>;
}) {
  return (
    <Tag ref={ref as unknown as Ref<HTMLDivElement>} className={`landing-panel overflow-hidden rounded-2xl border border-fd-border ${className}`}>
      {children}
    </Tag>
  );
}

/** The small mono label that names the artifact a specimen came from. */
export function PanelLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-mono text-[11.5px] tracking-[0.02em] text-fd-muted-foreground ${className}`}>{children}</span>
  );
}
