"use client";

import { useId } from "react";

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
};

export function Input({ label, error, className = "", ...rest }: InputProps) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className="flex w-full flex-col gap-1.5">
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
      )}
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`w-full rounded-2xl border bg-field px-4 py-3 text-sm text-foreground placeholder:text-muted-light focus:bg-background focus:outline-none focus:ring-2 transition-shadow ${
          error
            ? "border-error-border focus:ring-error/30"
            : "border-transparent focus:border-primary focus:ring-primary/25"
        } ${className}`}
        {...rest}
      />
      {error && (
        <p id={errorId} className="text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}
