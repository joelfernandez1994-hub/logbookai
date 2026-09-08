import React from "react";
import { NotebookPen } from "lucide-react";

// `brand` opts a page into the LogbookAI wordmark lockup above the page's own
// icon/title. Off by default and additive-only so Login.jsx (which doesn't
// pass it) renders pixel-identical to before — the sign-up/verify-email
// polish pass this was added for must not touch the existing login flow.
export default function AuthLayout({ icon: Icon, title, subtitle, footer, children, brand = false }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="w-full max-w-md">
        {brand && (
          <div className="flex items-center justify-center gap-2 mb-8">
            <div className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-primary">
              <NotebookPen className="w-4.5 h-4.5 text-primary-foreground" aria-hidden="true" />
            </div>
            <span className="text-base font-bold tracking-tight text-foreground" data-no-translate>
              LogbookAI
            </span>
          </div>
        )}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary mb-4">
            <Icon className="w-7 h-7 text-primary-foreground" aria-hidden="true" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{title}</h1>
          {subtitle && <p className="text-muted-foreground mt-2">{subtitle}</p>}
        </div>
        <div className="bg-card rounded-2xl shadow-sm border border-border p-8">
          {children}
        </div>
        {footer && (
          <p className="text-center text-sm text-muted-foreground mt-6">{footer}</p>
        )}
      </div>
    </div>
  );
}