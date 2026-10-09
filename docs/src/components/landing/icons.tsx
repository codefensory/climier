/**
 * One stroke set for the landing page: 24x24, 1.7 stroke, round joins.
 *
 * The landing owns these instead of pulling an icon package, so every glyph in
 * the hero, the graph, and the specimen panels keeps the same weight.
 */
const strokeProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function ArrowRight({ className = 'size-4' }: { className?: string }) {
  return (
    <svg {...strokeProps} className={className}>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

export function GithubIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg {...strokeProps} strokeWidth={1.5} className={className}>
      <path d="M9 19c-4.3 1.3-4.3-2.2-6-2.6m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.3 5.4 2.6 5.4 2.6a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V22" />
    </svg>
  );
}

export function CopyIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg {...strokeProps} className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6.5A2.5 2.5 0 0 0 4 5.5v6A2.5 2.5 0 0 0 6.5 14" />
    </svg>
  );
}

export function CheckIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg {...strokeProps} className={className}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

export function PlayIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg {...strokeProps} className={className} fill="currentColor" stroke="none">
      <path d="M8.2 5.4a.8.8 0 0 1 1.2-.7l9 6.3a.8.8 0 0 1 0 1.4l-9 6.3a.8.8 0 0 1-1.2-.7z" />
    </svg>
  );
}

export function PauseIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg {...strokeProps} className={className} fill="currentColor" stroke="none">
      <rect x="7" y="5" width="3.4" height="14" rx="1.2" />
      <rect x="13.6" y="5" width="3.4" height="14" rx="1.2" />
    </svg>
  );
}

export function ReplayIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg {...strokeProps} className={className}>
      <path d="M20 11.5a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </svg>
  );
}

/** Status glyphs. Shape carries the state, so color is never the only signal. */
export function DotGlyph({ className = 'size-2' }: { className?: string }) {
  return <span className={`inline-block rounded-full bg-current ${className}`} aria-hidden="true" />;
}

/** Direction marker for a graph edge. */
export function ChevronIcon({ className = 'size-2.5' }: { className?: string }) {
  return (
    <svg {...strokeProps} strokeWidth={2.6} className={className}>
      <path d="m9 5.5 6.5 6.5-6.5 6.5" />
    </svg>
  );
}

export function BarredRingGlyph({ className = 'size-2.5' }: { className?: string }) {
  return (
    <svg {...strokeProps} strokeWidth={1.4} className={className}>
      <circle cx="12" cy="12" r="7" />
      <path d="M8 12h8" />
    </svg>
  );
}

export function DiamondGlyph({ className = 'size-2.5' }: { className?: string }) {
  return (
    <svg {...strokeProps} strokeWidth={1.4} className={className}>
      <path d="M12 4.5 19.5 12 12 19.5 4.5 12z" />
    </svg>
  );
}

export function UpGlyph({ className = 'size-3' }: { className?: string }) {
  return (
    <svg {...strokeProps} strokeWidth={1.5} className={className}>
      <path d="M12 19V6" />
      <path d="m6.5 11.5 5.5-5.5 5.5 5.5" />
    </svg>
  );
}
