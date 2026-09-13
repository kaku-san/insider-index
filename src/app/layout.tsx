import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppProviders } from "@/components/providers/app-providers";
import { EligibilityBanner } from "@/components/eligibility-banner";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Stocklana",
  description:
    "Form 4 insider disclosures to user-signed xStock trades on Solana.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-[#070b12] text-zinc-100">
        <AppProviders>
          <EligibilityBanner />
          <SiteHeader />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
        </AppProviders>
      </body>
    </html>
  );
}
