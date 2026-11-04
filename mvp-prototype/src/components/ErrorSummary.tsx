import { forwardRef } from 'react';
import type { FieldError } from '../data/validate';

// Error summary at the top of the form. The form moves focus here after a
// failed submit; each message links to (and focuses) the field it is about.

function focusField(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.focus();
  el.scrollIntoView({ block: 'center' });
}

const ErrorSummary = forwardRef<HTMLDivElement, { errors: FieldError[] }>(function ErrorSummary(
  { errors },
  ref,
) {
  return (
    <div className="error-summary" ref={ref} tabIndex={-1} aria-labelledby="error-summary-title">
      <h3 id="error-summary-title">
        {errors.length === 1 ? 'There is a problem to fix' : `There are ${errors.length} problems to fix`}
      </h3>
      <ul>
        {errors.map((e) => (
          <li key={`${e.fieldId}:${e.message}`}>
            <a
              href={`#${e.fieldId}`}
              onClick={(event) => {
                event.preventDefault();
                focusField(e.fieldId);
              }}
            >
              {e.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
});

export default ErrorSummary;
