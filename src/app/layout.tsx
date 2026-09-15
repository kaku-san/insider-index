import type { Metadata } from "next";
import { type ReactNode } from "react";
import { AppProviders } from "@/components/providers/app-providers";
import { EligibilityBanner } from "@/components/eligibility-banner";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const SITE_TITLE = "InsiderIndex — Everyone is an insider.";
const SITE_DESCRIPTION =
  "Explore published trade indexes and the public disclosures behind them. Original books, transparent target weights, and personal decisions. Everyone is an insider.";

export const metadata: Metadata = {
  metadataBase: new URL("https://insiderindex.xyz"),
  title: {
    default: SITE_TITLE,
    template: "%s · InsiderIndex",
  },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    url: "https://insiderindex.xyz",
    siteName: "InsiderIndex",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
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
              <strong>InsiderIndex</strong>
            </footer>
          </div>
        </AppProviders>
      </body>
    </html>
  );
}
