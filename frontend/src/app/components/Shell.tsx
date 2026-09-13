import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { ArrowLeft, Music2 } from "lucide-react";

/* Shared chrome used by every screen, so the dark Tabify shell, the nav bar
   and the button variants stay identical across the flow. */

export function Screen({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`min-h-screen bg-black text-[#f0ece4] flex flex-col font-[Figtree,sans-serif] ${className}`}>
      {children}
    </div>
  );
}

export function NavBar({ onBack, title, right }: {
  onBack?: () => void; title?: string; right?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-white/5 shrink-0">
      {onBack ? (
        <button onClick={onBack}
          className="flex items-center gap-1.5 text-[#9490a0] hover:text-[#f0ece4] transition-colors text-sm">
          <ArrowLeft size={14} /><span>Back</span>
        </button>
      ) : (
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[#3b82f6] flex items-center justify-center shadow-[0_0_12px_rgba(59,130,246,0.55)]">
            <Music2 size={14} className="text-white" />
          </div>
          <span style={{ fontFamily: "Fraunces,serif" }} className="text-[#f0ece4] font-medium tracking-wide text-lg">
            Tabify
          </span>
        </div>
      )}
      {title && (
        <span className="text-[10px] text-[#5e5a70] uppercase tracking-[0.15em] font-medium">{title}</span>
      )}
      <div className="w-16 flex justify-end">{right}</div>
    </header>
  );
}

export function Btn({
  children, onClick, variant = "primary", disabled = false, className = "", icon, type = "button",
}: {
  children: ReactNode; onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean; className?: string; icon?: ReactNode;
  type?: "button" | "submit";
}) {
  const base = "inline-flex items-center gap-2 px-5 py-2.5 rounded-full font-medium text-sm transition-all duration-200 select-none disabled:opacity-40 disabled:cursor-not-allowed";
  const map = {
    primary:   "bg-[#f0c040] hover:bg-[#f8cc50] text-black",
    secondary: "bg-white/7 hover:bg-white/11 text-[#f0ece4] border border-white/10",
    ghost:     "text-[#9490a0] hover:text-[#f0ece4] hover:bg-white/5",
    danger:    "bg-[#e8603c]/12 hover:bg-[#e8603c]/22 text-[#e07a62] border border-[#e8603c]/22",
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${map[variant]} ${className}`}>
      {icon}{children}
    </button>
  );
}

export function Document({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex-1 overflow-y-auto rounded-2xl bg-white shadow-[0_24px_72px_rgba(0,0,0,0.65)] p-8"
      style={{ scrollbarWidth: "none" }}
    >
      {children}
    </div>
  );
}

/* ─── FORM BITS ─── */

export const Field = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string }>(
  function Field({ label, className = "", ...props }, ref) {
    return (
      <label className="block">
        <span className="text-[#5e5a70] text-[10px] uppercase tracking-widest mb-2 block">{label}</span>
        <input
          ref={ref}
          {...props}
          className={`w-full bg-white/5 border border-white/8 rounded-xl px-4 py-3 text-sm text-[#f0ece4] placeholder:text-[#3c3850] outline-none focus:border-[#f0c040]/45 transition-colors ${className}`}
        />
      </label>
    );
  }
);

export function Notice({ kind = "error", children }: { kind?: "error" | "success"; children: ReactNode }) {
  if (!children) return null;
  const styles = kind === "error"
    ? "bg-[#e8603c]/10 border-[#e8603c]/25 text-[#e8917c]"
    : "bg-[#30d8a0]/10 border-[#30d8a0]/25 text-[#5fe0b8]";
  return (
    <div className={`rounded-xl border px-4 py-3 text-[13px] leading-relaxed ${styles}`} role="alert">
      {children}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`w-4 h-4 rounded-full border-2 border-current border-t-transparent inline-block animate-spin ${className}`}
    />
  );
}
