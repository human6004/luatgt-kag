import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="px-5 md:px-8 py-7 min-h-full bg-bg">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="min-w-0 max-w-full break-words">
          <h1 className="text-2xl font-semibold text-navy">{title}</h1>
          {subtitle && (
            <p className="mt-1 text-[13px] text-muted">{subtitle}</p>
          )}
        </div>
        {actions && (
          <div className="flex w-full max-w-full flex-wrap items-center gap-2 sm:w-auto">
            {actions}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

export function Card({
  title,
  right,
  className = "",
  children,
  flush = false,
}: {
  title?: string;
  right?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  flush?: boolean;
}) {
  const surfaceClass =
    "min-w-0 overflow-x-auto [overflow-wrap:anywhere] bg-surface rounded-2xl border border-line shadow-[0_1px_2px_rgba(53,45,36,0.04)]";
  if (!title)
    return (
      <section className={`${surfaceClass} ${className}`}>{children}</section>
    );
  return (
    <section className={`min-w-0 flex flex-col gap-3 ${className}`}>
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3 sm:items-center">
        <h2 className="min-w-0 break-words text-base sm:text-lg leading-6 font-semibold text-navy">
          {title}
        </h2>
        {right && (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            {right}
          </div>
        )}
      </header>
      <div className={`${surfaceClass} flex-1 ${flush ? "" : "pt-5"}`}>
        {children}
      </div>
    </section>
  );
}

type BtnVariant = "primary" | "dark" | "ghost" | "outline" | "danger";
export function NavLinkButton({
  to,
  children,
  size = "md",
  className = "",
}: {
  to: string;
  children: React.ReactNode;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={`inline-flex max-w-full items-center justify-center gap-2 rounded-xl border border-line bg-surface text-center font-semibold text-navy transition-colors hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong focus-visible:ring-offset-2 ${size === "sm" ? "min-h-9 px-3 py-1.5 text-xs" : "min-h-10 px-4 py-2 text-[13px]"} ${className}`}
    >
      <span>{children}</span>
      <svg
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-accent-strong"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          d="M14 5l7 7m0 0l-7 7m7-7H3"
        />
      </svg>
    </Link>
  );
}

export function FilterTabs<T extends string>({
  label,
  value,
  items,
  onChange,
  disabled = false,
  className = "",
}: {
  label: string;
  value: T;
  items: readonly { value: T; label: React.ReactNode }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`flex min-w-0 max-w-full items-center gap-5 overflow-x-auto border-b border-line ${className}`}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          disabled={disabled}
          onClick={() => onChange(item.value)}
          className={`min-h-10 shrink-0 whitespace-nowrap border-b-2 py-2 text-sm font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent-strong ${value === item.value ? "border-navy text-navy" : "border-transparent text-muted hover:text-navy"}`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

const btn: Record<BtnVariant, string> = {
  primary: "bg-accent text-navy hover:bg-accent-hover",
  dark: "bg-navy text-bg hover:bg-navy-light",
  ghost:
    "text-navy underline underline-offset-4 decoration-navy/40 hover:bg-selected hover:decoration-navy",
  outline:
    "border border-navy/35 bg-selected text-navy hover:border-navy/60 hover:bg-line",
  danger:
    "text-red-700 underline underline-offset-4 decoration-red-700/40 hover:bg-red-50 hover:decoration-red-700",
};
export function Button({
  variant = "outline",
  size = "md",
  className = "",
  ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  size?: "sm" | "md";
}) {
  return (
    <button
      {...p}
      className={`inline-flex max-w-full items-center justify-center gap-1.5 rounded-md text-center leading-5 font-semibold cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-strong focus-visible:ring-offset-2 ${
        size === "sm"
          ? "min-h-8 px-3 py-1.5 text-xs"
          : "min-h-10 px-4 py-2 text-[13px]"
      } ${btn[variant]} ${className}`}
    />
  );
}

export function EditIconButton({
  label = "Chỉnh sửa",
  title = label,
  disabled,
  onClick,
}: {
  label?: string;
  title?: string;
  disabled?: boolean;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-selected hover:text-navy disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent-strong"
    >
      <svg
        aria-hidden="true"
        className="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m16 3 5 5-13 13H3v-5L16 3Z" />
        <path d="m13 6 5 5" />
      </svg>
    </button>
  );
}

export function FilePicker({
  title,
  hint,
  accept,
  multiple,
  disabled,
  onChange,
}: {
  title: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  onChange: React.ChangeEventHandler<HTMLInputElement>;
}) {
  const [selection, setSelection] = useState("");
  return (
    <label
      className={`relative flex min-w-0 flex-col items-center gap-2 rounded-xl border border-dashed border-accent-strong/45 bg-bg px-4 py-5 text-center focus-within:ring-2 focus-within:ring-accent-strong ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-sidebar"}`}
    >
      <span className="text-sm font-medium text-navy">{title}</span>
      <span className="text-xs text-muted">{hint}</span>
      <span className="mt-1 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-navy">
        {multiple ? "Chọn các tệp" : "Chọn tệp"}
      </span>
      <input
        type="file"
        className="sr-only"
        aria-label={title}
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          const input = event.currentTarget;
          onChange(event);
          const files = input.files;
          setSelection(
            files?.length === 1
              ? files[0].name
              : files?.length
                ? `${files.length} tệp đã chọn`
                : "",
          );
        }}
      />
      {selection && (
        <span className="max-w-full break-all text-xs text-muted">
          {selection}
        </span>
      )}
    </label>
  );
}

const tones = {
  green: "text-emerald-700",
  amber: "text-amber-700",
  red: "text-red-700",
  gray: "text-text-secondary",
  gold: "text-accent-strong",
};
export type Tone = keyof typeof tones;
export function Badge({
  tone = "gray",
  children,
}: {
  tone?: Tone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-block whitespace-nowrap text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "md" | "lg";
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.showModal();
    const firstInput = dialog.querySelector<HTMLElement>(
      'input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled)',
    );
    firstInput?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      aria-modal="true"
      className={`fixed inset-0 m-auto w-[calc(100%_-_2rem)] ${size === "lg" ? "max-w-4xl" : "max-w-lg"} max-h-[90dvh] border-0 bg-transparent p-0 text-navy backdrop:bg-navy/30 backdrop:backdrop-blur-[2px]`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const controls = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((node) => node.getClientRects().length > 0);
        const first = controls[0],
          last = controls[controls.length - 1];
        if (!first) {
          e.preventDefault();
          return;
        }
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90dvh] flex flex-col rounded-2xl bg-bg border border-line shadow-2xl">
        <div className="shrink-0 flex items-start justify-between gap-3 px-5 py-4 border-b border-line">
          <h3 className="min-w-0 break-words text-[15px] leading-6 font-semibold text-navy">
            {title}
          </h3>
          <button
            onClick={onClose}
            aria-label="Đóng"
            className="shrink-0 p-1.5 rounded-lg text-muted hover:bg-selected hover:text-navy"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 min-w-0 p-5 overflow-y-auto overscroll-contain [overflow-wrap:anywhere]">
          {children}
        </div>
        {footer && (
          <div className="shrink-0 flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-line">
            {footer}
          </div>
        )}
      </div>
    </dialog>
  );
}

export function RequiredMark() {
  return (
    <span aria-hidden="true" className="ml-1 font-semibold text-red-700">
      *
    </span>
  );
}

export function Field({
  label,
  hint,
  required = false,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block min-w-0">
      <span className="block text-xs font-medium text-text-secondary mb-1.5">
        {label}
        {required && <RequiredMark />}
      </span>
      {children}
      {hint && (
        <span className="block mt-1 text-[11.5px] text-muted">{hint}</span>
      )}
    </label>
  );
}

export const inputCls =
  "w-full min-w-0 rounded-xl border border-line bg-white/70 px-3 py-2 text-[13.5px] leading-6 text-navy outline-none placeholder:text-muted/70 focus:border-accent focus:ring-4 focus:ring-accent/10 transition";

export function Th({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`text-left align-top px-4 py-2.5 text-[11.5px] leading-5 font-medium uppercase tracking-wide text-muted ${className}`}
    >
      {children}
    </th>
  );
}
export function Td({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`align-top px-4 py-3 text-[13.5px] leading-6 ${className}`}>
      {children}
    </td>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${checked ? "bg-accent" : "bg-line"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`}
      />
    </button>
  );
}
