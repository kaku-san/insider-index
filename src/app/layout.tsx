import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { AppProviders } from "@/components/providers/app-providers";
import { EligibilityBanner } from "@/components/eligibility-banner";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";
import "./consumer.css";

const SITE_TITLE = "InsiderIndex — Famous portfolios. Public receipts.";
const SITE_DESCRIPTION =
  "Explore public politician and executive disclosures, follow people, and access user-signed person indexes.";

export const metadata: Metadata = {
  metadataBase: new URL("https://insiderindex.xyz"),
  title: {
    default: SITE_TITLE,
    template: "%s · InsiderIndex",
  },
  description: SITE_DESCRIPTION,
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    siteName: "InsiderIndex",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
};

const themeScript = `try{var t=localStorage.getItem('insiderindex:theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" suppressHydrationWarning>
    <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
    <body>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Suspense fallback={<div className="app-loading">Opening InsiderIndex…</div>}>
        <AppProviders>
          <SiteHeader />
          <div className="consumer-app-frame">
            <EligibilityBanner />
            <main id="main-content" className="consumer-main">{children}</main>
            <footer className="consumer-footer">
              <div><strong>InsiderIndex</strong><span>Famous portfolios. Public receipts.</span><span className="consumer-footer-credit">Built by Kaku · <a href="https://github.com/kaku-san" target="_blank" rel="noopener noreferrer">GitHub</a> · <a href="https://x.com/kakujain" target="_blank" rel="noopener noreferrer">@kakujain on X</a></span></div>
              <p>Public disclosures can be delayed, partial, household-owned, and different from current positions. Research first. Not investment advice.</p>
            </footer>
          </div>
        </AppProviders>
      </Suspense>
    </body>
  </html>;
}
