import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function Panel({ title, actions, children, className = "" }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-border bg-surface ${className}`} aria-label={title}>
      {title && (
        <header className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <h3 className="text-[13px] font-medium text-text-primary">{title}</h3>
          {actions}
        </header>
      )}
      <div className="px-3 py-3">{children}</div>
    </section>
  );
}

/** Numbered section label in the design's mono caps style, e.g. "01 / Repository Source". */
export function SectionLabel({ index, children }: { index: string; children: ReactNode }) {
  return (
    <span className="font-mono text-[11px] font-medium uppercase leading-[14px] tracking-[0.03em] text-[#5E626E]">
      {index} / {children}
    </span>
  );
}

type Tone = "success" | "danger" | "warning" | "accent" | "neutral";

const TONE_STYLES: Record<Tone, string> = {
  success: "bg-[#27A567]/10 text-[#34D399] ring-[#27A567]/25",
  danger: "bg-[#E5484D]/10 text-[#E5484D] ring-[#E5484D]/25",
  warning: "bg-[#E5A158]/10 text-[#E5A158] ring-[#E5A158]/25",
  accent: "bg-[#5E6AD2]/10 text-[#BDC2FF] ring-[#5E6AD2]/30",
  neutral: "bg-[#282A31] text-[#8A8F98] ring-[#2E3038]",
};

const DOT_STYLES: Record<Tone, string> = {
  success: "bg-[#27A567]",
  danger: "bg-[#E5484D]",
  warning: "bg-[#E5A158]",
  accent: "bg-[#5E6AD2]",
  neutral: "bg-[#5E626E]",
};

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium ring-1 ring-inset ${TONE_STYLES[tone]}`}>
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
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger-ghost"; loading?: boolean }) {
  const styles = {
    primary:
      "bg-[#5E6AD2] text-white shadow-sm shadow-[#5E6AD2]/25 hover:bg-[#6875E3] active:translate-y-px disabled:bg-[#282A31] disabled:text-[#5E626E] disabled:shadow-none",
    secondary:
      "border border-[#2E3038] bg-[#222329] text-[#ECEEF0] hover:border-[#424652] hover:bg-[#282A31] disabled:text-[#5E626E]",
    "danger-ghost": "text-[#E5484D] ring-1 ring-[#E5484D]/30 hover:bg-[#E5484D]/10 disabled:text-[#5E626E]",
  }[variant];
  return (
    <button
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-all disabled:cursor-not-allowed ${styles} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading}
      {...props}
    >
      {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: ReactNode; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[13px] font-medium text-[#ECEEF0]">
        {label}
        <span className="mt-1 block">{children}</span>
      </label>
      {error ? (
        <p className="mt-1 text-[12px] text-[#E5484D]" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1 text-[12px] leading-4 text-[#5E626E]">{hint}</p>
      )}
    </div>
  );
}

const INPUT_CLASS =
  "w-full rounded-md border border-[#2E3038] bg-[#141518] px-3 text-[13px] text-[#ECEEF0] placeholder:text-[#5E626E] transition-colors hover:border-[#363840] focus:border-[#5E6AD2] focus:outline-none focus:ring-1 focus:ring-[#5E6AD2] disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${INPUT_CLASS} h-8 ${className}`} />;
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${INPUT_CLASS} resize-y py-2 font-mono text-[12px] leading-[18px] ${className}`} />;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-[#1E2026] ${className}`} aria-hidden />;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-[#2E3038] px-6 py-10 text-center">
      <p className="text-[13px] font-medium text-[#ECEEF0]">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[12px] leading-4 text-[#8A8F98]">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[150px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-[#8A8F98]">{key}</dt>
          <dd className="min-w-0 text-[#ECEEF0]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
