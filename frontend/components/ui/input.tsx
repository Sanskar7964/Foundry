import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded border border-border bg-base px-3 py-2 text-sm text-ink tabular",
        "placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass",
        "disabled:opacity-40",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
