import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Star, LoaderCircle, RefreshCw, ChevronRight } from 'lucide-react';

const cx = (...parts) => parts.filter(Boolean).join(' ');
export { cx };

// ---------- toast ----------
const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);
const ClearToastsContext = createContext(() => {});
/** Takes every toast off the screen at once: for a dialog that opens where they would cover its buttons. */
export const useClearToasts = () => useContext(ClearToastsContext);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = (message, kind = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3200);
  };
  const clear = () => setToasts([]);
  return (
    <ToastContext.Provider value={push}>
      <ClearToastsContext.Provider value={clear}>{children}</ClearToastsContext.Provider>
      <div className="no-print fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('animate-pop-in max-w-sm rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-lg', t.kind === 'error' ? 'bg-red-700' : 'bg-stone-900')}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Wrap an async handler: tracks a busy flag and surfaces failures as a toast. */
export function useAction(fn) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (...args) => {
    setBusy(true);
    try {
      return await fn(...args);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return [run, busy];
}

// ---------- basics ----------
const BUTTON_VARIANTS = {
  primary: 'bg-brand-700 text-white hover:bg-brand-800 border-transparent shadow-sm',
  secondary: 'bg-white text-stone-800 hover:bg-stone-50 border-line shadow-sm',
  ghost: 'bg-transparent text-stone-600 hover:bg-stone-900/5 border-transparent',
  danger: 'bg-white text-red-700 hover:bg-red-50 border-red-200 shadow-sm',
  dangerSolid: 'bg-red-700 text-white hover:bg-red-800 border-transparent shadow-sm',
};

export function Button({ variant = 'secondary', size = 'md', icon: Icon, busy, className, children, ...props }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border font-medium whitespace-nowrap transition-colors disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        BUTTON_VARIANTS[variant], className,
      )}
    >
      {busy ? <LoaderCircle className="size-4 animate-spin" /> : Icon ? <Icon className="size-4" /> : null}
      {children}
    </button>
  );
}

const fieldClass =
  'w-full rounded-lg border border-line bg-white px-3 text-sm text-stone-900 placeholder:text-stone-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-stone-50 disabled:text-stone-500';

export const Input = React.forwardRef(function Input({ className, ...props }, ref) {
  return <input ref={ref} {...props} className={cx(fieldClass, 'h-9', className)} />;
});
export function Select({ className, children, ...props }) {
  return <select {...props} className={cx(fieldClass, 'h-9 pr-8', className)}>{children}</select>;
}
export function Textarea({ className, rows = 4, ...props }) {
  return <textarea rows={rows} {...props} className={cx(fieldClass, 'py-2 leading-relaxed', className)} />;
}
export function Field({ label, hint, className, children }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-[13px] font-medium text-stone-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-stone-500">{hint}</span>}
    </label>
  );
}
export function Checkbox({ label, hint, ...props }) {
  return (
    <label className="flex items-start gap-2.5 text-sm text-stone-700">
      <input type="checkbox" {...props} className="mt-0.5 size-4 rounded border-stone-300 accent-brand-700" />
      <span>
        {label}
        {hint && <span className="block text-xs text-stone-500">{hint}</span>}
      </span>
    </label>
  );
}
/** A small on/off switch with its label beside it, for a setting that takes effect as soon as it is flipped. */
export function Switch({ checked, onChange, label, className }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
      className={cx('inline-flex items-center gap-2 rounded text-[13px] font-medium text-stone-600 hover:text-stone-900', className)}>
      <span className={cx('relative h-[18px] w-8 shrink-0 rounded-full transition-colors', checked ? 'bg-brand-700' : 'bg-stone-300')}>
        <span className={cx('absolute top-0.5 left-0.5 size-3.5 rounded-full bg-white shadow-sm transition-transform', checked && 'translate-x-3.5')} />
      </span>
      {label}
    </button>
  );
}

const BADGE_TONES = {
  gray: 'bg-stone-100 text-stone-700 ring-stone-200',
  green: 'bg-brand-50 text-brand-700 ring-brand-200',
  amber: 'bg-gold-50 text-gold-800 ring-gold-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  blue: 'bg-sky-50 text-sky-800 ring-sky-200',
  violet: 'bg-violet-50 text-violet-800 ring-violet-200',
};
export function Badge({ tone = 'gray', icon: Icon, className, children }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', BADGE_TONES[tone], className)}>
      {Icon && <Icon className="size-3" />}
      {children}
    </span>
  );
}

const AVATAR_COLORS = ['#0c505d', '#0b6e99', '#b45309', '#7c3aed', '#be123c', '#4d7c0f', '#0f766e', '#6d28d9', '#a16207'];
export function Avatar({ name = '?', color, size = 32, className, src }) {
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  const hash = [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 7);
  // A photo that fails to load (deleted, or hidden from this person) falls back to the initials.
  const [failed, setFailed] = useState(null);
  if (src && failed !== src) {
    return (
      <img src={src} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(src)}
        className={cx('inline-block shrink-0 rounded-full bg-stone-200 object-cover', className)} style={{ width: size, height: size }} />
    );
  }
  return (
    <span
      className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none', className)}
      style={{ width: size, height: size, fontSize: size * 0.38, background: color || AVATAR_COLORS[hash % AVATAR_COLORS.length] }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
export function ClientDot({ color, className }) {
  return <span className={cx('inline-block size-2 shrink-0 rounded-full', className)} style={{ background: color }} />;
}

export function Card({ className, children, ...props }) {
  return <div {...props} className={cx('rounded-xl border border-line bg-white', className)}>{children}</div>;
}
export function CardHeader({ title, action, count }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
      <h2 className="text-sm font-semibold text-stone-900">
        {title}
        {count != null && <span className="ml-1.5 font-normal text-stone-500">{count}</span>}
      </h2>
      {action}
    </div>
  );
}

export function Empty({ icon: Icon, title, children, action }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {Icon && (
        <span className="mb-3 flex size-10 items-center justify-center rounded-full bg-stone-100 text-stone-500">
          <Icon className="size-5" />
        </span>
      )}
      <p className="text-sm font-medium text-stone-900">{title}</p>
      {children && <p className="mt-1 max-w-sm text-sm text-stone-500">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Loading({ className }) {
  return (
    <div className={cx('flex items-center justify-center py-16 text-stone-400', className)}>
      <LoaderCircle className="size-5 animate-spin" />
    </div>
  );
}

/** Shown in place of a part of the app that could not be loaded because a newer version has replaced this one. */
export function UpdateNotice({ children, className }) {
  return (
    <div role="alert" className={cx('flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950', className)}>
      <span className="min-w-0 flex-1 basis-56">
        <span className="font-medium">The Book has been updated.</span> Refresh the page to continue.
        {children && <span className="mt-0.5 block text-[13px] text-amber-900">{children}</span>}
      </span>
      <Button size="sm" variant="primary" icon={RefreshCw} onClick={() => window.location.reload()}>Refresh</Button>
    </div>
  );
}

export function Tabs({ tabs, value, onChange, className }) {
  return (
    <div className={cx('flex gap-1 overflow-x-auto border-b border-line', className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
            value === t.id ? 'border-brand-700 text-brand-800' : 'border-transparent text-stone-500 hover:text-stone-800',
          )}
        >
          {t.label}
          {t.count != null && (
            <span className={cx('tabular rounded-full px-1.5 text-xs', value === t.id ? 'bg-brand-100 text-brand-800' : 'bg-stone-100 text-stone-600')}>{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Stars({ value, onChange, size = 16 }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => {
        const star = <Star style={{ width: size, height: size }} className={n <= (value || 0) ? 'fill-amber-400 text-amber-400' : 'text-stone-300'} />;
        return onChange ? (
          <button key={n} type="button" aria-label={`Rate ${n} out of 5`} onClick={() => onChange(n === value ? null : n)} className="rounded hover:scale-110">
            {star}
          </button>
        ) : (
          <span key={n}>{star}</span>
        );
      })}
    </span>
  );
}

// ---------- overlays ----------
// Dialogs and drawers cover the window from just below the call-recording strip (when there is one), so the strip and
// its Stop button stay in view whatever is open.
const belowRecordingBar = { top: 'var(--recording-bar, 0px)' };
// Open overlays, oldest first. Escape closes only the last one, so a modal on top of the drawer does not take the drawer with it.
const overlays = [];
function useEscape(onClose) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const token = {};
    overlays.push(token);
    const handler = (e) => {
      if (e.key !== 'Escape' || overlays.at(-1) !== token) return;
      e.stopPropagation();
      latest.current();
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      overlays.splice(overlays.indexOf(token), 1);
    };
  }, []);
}

export function Modal({ title, subtitle, onClose, children, footer, size = 'md', onSubmit }) {
  useEscape(onClose);
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' };
  const Body = onSubmit ? 'form' : 'div';
  return (
    <div className="animate-fade-in fixed inset-0 z-[60] flex items-end justify-center bg-stone-950/40 p-0 sm:items-center sm:p-6" style={belowRecordingBar} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Body
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={onSubmit ? (e) => { e.preventDefault(); onSubmit(e); } : undefined}
        className={cx('animate-pop-in flex max-h-[calc(92dvh-var(--recording-bar,0px))] w-full flex-col rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl', widths[size])}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-stone-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-stone-500">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1 rounded-md p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
            <X className="size-5" />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </Body>
    </div>
  );
}

export function Drawer({ onClose, children, label }) {
  useEscape(onClose);
  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex justify-end bg-stone-950/30" style={belowRecordingBar} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={label} className="animate-slide-in flex h-full w-full max-w-[900px] flex-col border-l border-line bg-paper shadow-2xl shadow-brand-950/20">
        {children}
      </div>
    </div>
  );
}

/**
 * Button that opens a small menu. `items` is a list of { label, onClick, icon, danger } or null for a divider.
 * The menu opens below its button, or above it when it would otherwise run off the bottom of the window.
 */
export function Menu({ trigger, items, align = 'right', className }) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const ref = useRef(null);
  const list = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  // Measured before the menu is first seen, so it never jumps from below to above.
  useLayoutEffect(() => {
    if (!open) { setAbove(false); return; }
    const menu = list.current.getBoundingClientRect(), button = ref.current.getBoundingClientRect();
    setAbove(menu.bottom > window.innerHeight - 8 && button.top - menu.height > 8);
  }, [open]);
  return (
    <div ref={ref} className={cx('relative', className)}>
      {React.cloneElement(trigger, { onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <div ref={list} role="menu" className={cx('animate-pop-in absolute z-40 min-w-48 overflow-hidden rounded-lg border border-line bg-white py-1 shadow-lg', above ? 'bottom-full mb-1' : 'mt-1', align === 'right' ? 'right-0' : 'left-0')}>
          {items.filter((i) => i !== false).map((item, i) =>
            item === null ? (
              <div key={i} className="my-1 border-t border-line" />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); item.onClick(); }}
                className={cx('flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-stone-50', item.danger ? 'text-red-700' : 'text-stone-700')}
              >
                {item.icon && <item.icon className="size-4 shrink-0 opacity-70" />}
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function Page({ title, subtitle, actions, children, wide }) {
  return (
    <div className={cx('mx-auto w-full px-4 py-6 sm:px-8 sm:py-8', wide ? 'max-w-none' : 'max-w-6xl')}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="display text-[28px] leading-tight text-stone-900 sm:text-[30px]">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-stone-500">{subtitle}</p>}
        </div>
        {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/** A row of figures in one strip, divided by hairlines rather than boxed one by one. Holds `Stat`s. */
export function StatStrip({ cols = 6, children, className }) {
  const wide = { 4: 'md:grid-cols-4', 5: 'md:grid-cols-5', 6: 'md:grid-cols-3 xl:grid-cols-6' }[cols];
  return <div className={cx('grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line', wide, className)}>{children}</div>;
}
export function Stat({ label, value, hint, to, Link, accent }) {
  const body = (
    <>
      <div className="text-xs font-medium text-stone-500">{label}</div>
      <div className={cx('tabular mt-1.5 text-[28px] leading-none font-semibold tracking-tight', accent ? 'text-brand-700' : 'text-stone-900')}>{value}</div>
      {hint && <div className="mt-2 text-xs text-stone-500">{hint}</div>}
    </>
  );
  const cls = 'block bg-white px-5 py-4';
  return to && Link ? <Link to={to} className={cx(cls, 'transition-colors hover:bg-brand-50/60')}>{body}</Link> : <div className={cls}>{body}</div>;
}

/**
 * One line in a list of things to open: an icon in a soft square, a title with a quieter line under it, something
 * on the right and a chevron. Rows sit one under another inside a Card, divided by hairlines.
 */
export function ListRow({ icon: Icon, title, detail, trailing, onClick, to, Link, className }) {
  const inner = (
    <>
      {Icon && <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><Icon className="size-4" /></span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-stone-900">{title}</span>
        {detail && <span className="block truncate text-xs text-stone-500">{detail}</span>}
      </span>
      {trailing}
      <ChevronRight className="size-4 shrink-0 text-stone-400" />
    </>
  );
  const cls = cx('flex w-full items-center gap-3.5 px-4 py-3 text-left transition-colors hover:bg-stone-50', className);
  if (to && Link) return <Link to={to} className={cls}>{inner}</Link>;
  return <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}
