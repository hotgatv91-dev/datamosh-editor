/** Shared UI primitives: buttons, fields, panels, modal, empty states. */

import { useId, type ReactNode } from 'react';
import clsx from 'clsx';
import styles from './ui.module.css';

type ButtonVariant = 'default' | 'primary' | 'mosh' | 'ghost' | 'danger';

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  active,
  title,
  className,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  active?: boolean;
  title?: string;
  className?: string;
  type?: 'button' | 'submit';
}) {
  const variantClass =
    variant === 'primary'
      ? styles.btnPrimary
      : variant === 'mosh'
        ? styles.btnMosh
        : variant === 'ghost'
          ? styles.btnGhost
          : variant === 'danger'
            ? styles.btnDanger
            : '';
  return (
    <button
      type={type}
      className={clsx(styles.btn, variantClass, active && styles.btnActive, className)}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

export function RangeField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  hint,
  onChange,
  onCommit,
  variant = 'default',
  keyframe,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hint?: string;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  variant?: 'default' | 'mosh';
  keyframe?: { animated: boolean; onToggle: () => void };
  disabled?: boolean;
}) {
  const id = useId();
  const decimals = step < 1 ? 2 : 0;
  return (
    <div className={styles.field} title={hint}>
      <div className={styles.fieldHead}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        <span className={styles.value}>
          {value.toFixed(decimals)}
          {unit ? <span className={styles.unit}>{unit}</span> : null}
        </span>
        {keyframe ? (
          <button
            type="button"
            className={clsx(styles.keyBtn, keyframe.animated && styles.keyBtnOn)}
            onClick={keyframe.onToggle}
            title={keyframe.animated ? 'Remove keyframe at playhead' : 'Add keyframe at playhead'}
          >
            ◆
          </button>
        ) : null}
      </div>
      <input
        id={id}
        className={clsx(styles.range, variant === 'mosh' && styles.rangeMosh)}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={(event) => onCommit?.(Number((event.target as HTMLInputElement).value))}
        onKeyUp={(event) => onCommit?.(Number((event.target as HTMLInputElement).value))}
      />
      {hint ? <div className={styles.hint}>{hint}</div> : null}
    </div>
  );
}

export function NumberField({
  label,
  value,
  onCommit,
  step = 1,
  min,
  max,
  suffix,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <div className={styles.field}>
      <div className={styles.fieldHead}>
        <span className={styles.label}>
          {label}
          {suffix ? <span className={styles.unit}> {suffix}</span> : null}
        </span>
      </div>
      <input
        className={styles.input}
        type="number"
        value={Number.isFinite(value) ? Number(value.toFixed(3)) : 0}
        step={step}
        min={min}
        max={max}
        onChange={(event) => onCommit(Number(event.target.value))}
      />
    </div>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className={styles.field} title={hint}>
      <div className={styles.fieldHead}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
      </div>
      <select
        id={id}
        className={styles.select}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <div className={styles.hint}>{hint}</div> : null}
    </div>
  );
}

export function ToggleField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}) {
  return (
    <div className={styles.field} title={hint}>
      <label className={styles.toggle}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
      {hint ? <div className={styles.hint}>{hint}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  children,
  action,
  collapsible,
  open = true,
  onToggle,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <section className={styles.panel}>
      {title ? (
        <header className={styles.panelHead}>
          <span>{title}</span>
          {action}
          {collapsible ? (
            <button type="button" className={styles.panelToggle} onClick={onToggle}>
              {open ? 'Hide' : 'Show'}
            </button>
          ) : null}
        </header>
      ) : null}
      {open ? <div className={styles.panelBody}>{children}</div> : null}
    </section>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>{title}</div>
      {hint ? <div className={styles.emptyHint}>{hint}</div> : null}
    </div>
  );
}

export function Modal({
  title,
  children,
  footer,
  onClose,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className={styles.modalScrim}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.modal} role="dialog" aria-label={title}>
        <header className={styles.modalHead}>{title}</header>
        <div className={styles.modalBody}>{children}</div>
        {footer ? <footer className={styles.modalFoot}>{footer}</footer> : null}
      </div>
    </div>
  );
}

export function ProgressBar({ percent, variant = 'default' }: { percent: number; variant?: 'default' | 'mosh' }) {
  return (
    <div className={styles.progressTrack}>
      <div
        className={clsx(styles.progressFill, variant === 'mosh' && styles.progressFillMosh)}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

export function Chip({ children, mosh }: { children: ReactNode; mosh?: boolean }) {
  return <span className={clsx(styles.chip, mosh && styles.chipMosh)}>{children}</span>;
}

export { styles as uiStyles };
