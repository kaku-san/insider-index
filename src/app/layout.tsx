import type { Metadata } from "next";
import { type ReactNode } from "react";
import { AppProviders } from "@/components/providers/app-providers";
import { EligibilityBanner } from "@/components/eligibility-banner";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Stocklana — Everyone is an insider.",
    template: "%s · Stocklana",
  },
  description:
    "Explore published trade indexes and the public disclosures behind them. Original books, transparent target weights, and personal decisions. Everyone is an insider.",
};

const themeScript = `try{var t=localStorage.getItem('stocklana:theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <AppProviders>
          <SiteHeader />
          <div className="app-frame">
            <EligibilityBanner />
            <main id="main-content" className="main-content">
              {children}
            </main>
            <footer className="app-footer">
              <span>Less noise. More receipts.</span>
              <span>Public disclosures ≠ live trades. Not investment advice.</span>
              <strong>stocklana.</strong>
            </footer>
          </div>
        </AppProviders>
      </body>
    </html>
  );
}
