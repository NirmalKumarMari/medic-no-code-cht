// Labelled form controls with hint and error text wired up for screen readers
// (aria-describedby, aria-invalid, aria-required). Hints are used instead of
// placeholders, which disappear while typing and are often low contrast.

import type { ReactNode } from 'react';

interface BaseProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
}

function ariaProps({ id, hint, error, required }: BaseProps) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return {
    'aria-required': required || undefined,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy || undefined,
  };
}

export function RequiredMark() {
  return (
    <span className="required-mark" aria-hidden="true">
      {' '}*
    </span>
  );
}

function FieldShell({ id, label, hint, error, required, className, children }: BaseProps & { children: ReactNode }) {
  const classes = ['field', error ? 'field-has-error' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <label htmlFor={id}>
        {label}
        {required && <RequiredMark />}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error">
          <span className="sr-only">Error: </span>
          {error}
        </p>
      )}
      {children}
    </div>
  );
}

interface TextFieldProps extends BaseProps {
  value: string;
  onChange: (value: string) => void;
  inputMode?: 'text' | 'numeric' | 'decimal';
  short?: boolean;
}

export function TextField({ value, onChange, inputMode, short, ...base }: TextFieldProps) {
  return (
    <FieldShell {...base}>
      <input
        id={base.id}
        type="text"
        inputMode={inputMode}
        className={short ? 'input-short' : undefined}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...ariaProps(base)}
      />
    </FieldShell>
  );
}

export interface Option {
  value: string;
  label: string;
}

interface SelectFieldProps extends BaseProps {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  /** Text for an empty first option, so nothing is chosen by default. */
  placeholder?: string;
}

export function SelectField({ value, onChange, options, placeholder, ...base }: SelectFieldProps) {
  return (
    <FieldShell {...base}>
      <select id={base.id} value={value} onChange={(e) => onChange(e.target.value)} {...ariaProps(base)}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

interface TextAreaFieldProps extends BaseProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}

export function TextAreaField({ value, onChange, rows = 3, ...base }: TextAreaFieldProps) {
  return (
    <FieldShell {...base}>
      <textarea
        id={base.id}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...ariaProps(base)}
      />
    </FieldShell>
  );
}
