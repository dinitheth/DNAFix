import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function Panel({ title, actions, children, className = "" }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-border bg-surface shadow-sm ${className}`} aria-label={title}>
      {title && (
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/** Numbered section label in the design's mono caps style, e.g. "01 / Repository Source". */
export function SectionLabel({ index, children }: { index: string; children: ReactNode }) {
  return (
    <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-text-muted">
      {index} / {children}
    </span>
  );
}

type Tone = "success" | "danger" | "warning" | "accent" | "neutral";

const TONE_STYLES: Record<Tone, string> = {
  success: "bg-emerald-500/10 text-success ring-emerald-500/25",
  danger: "bg-red-500/10 text-danger ring-red-500/25",
  warning: "bg-amber-500/10 text-warning ring-amber-500/25",
  accent: "bg-indigo-500/10 text-accent ring-indigo-500/30",
  neutral: "bg-slate-500/10 text-text-secondary ring-slate-500/25",
};

const DOT_STYLES: Record<Tone, string> = {
  success: "bg-success",
  danger: "bg-danger",
  warning: "bg-warning",
  accent: "bg-accent",
  neutral: "bg-text-muted",
};

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${TONE_STYLES[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${DOT_STYLES[tone]}`} aria-hidden />
      {children}
    </span>
  );
}

export function Button({
  variant = "secondary",
  loading = false,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger-ghost"; loading?: boolean }) {
  const styles = {
    primary:
      "bg-accent text-white shadow-sm shadow-accent/25 hover:bg-accent-hover active:translate-y-px disabled:bg-surface-elevated disabled:text-text-muted disabled:shadow-none disabled:ring-1 disabled:ring-border",
    secondary: "bg-[#222329] text-text-secondary ring-1 ring-border hover:bg-surface-elevated hover:text-text-primary disabled:text-text-muted",
    "danger-ghost": "text-danger ring-1 ring-red-500/30 hover:bg-red-500/10 disabled:text-text-muted",
  }[variant];
  return (
    <button
      className={`inline-flex h-8 items-center justify-center gap-2 rounded-md px-3.5 text-[13px] font-medium transition-all disabled:cursor-not-allowed ${styles}`}
      disabled={disabled || loading}
      aria-busy={loading}
      {...props}
    >
      {loading && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      )}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: ReactNode; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[13px] font-medium text-text-primary">
        {label}
        <span className="mt-0.5 block">{children}</span>
      </label>
      {hint && !error && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
      {error && (
        <p className="mt-1 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const INPUT_CLASS =
  "w-full rounded-md border border-border-strong bg-background px-3 text-sm text-text-primary placeholder:text-text-muted transition-colors hover:border-[#424652] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${INPUT_CLASS} h-8 ${className}`} />;
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${INPUT_CLASS} resize-y py-2.5 font-mono text-[13px] leading-relaxed ${className}`} />;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-elevated ${className}`} aria-hidden />;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[13px] text-text-secondary">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[150px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-text-muted">{key}</dt>
          <dd className="min-w-0 text-text-primary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
