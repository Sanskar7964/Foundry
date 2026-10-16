import type { Metadata } from "next";
import { Space_Grotesk, Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { SolanaProvider } from "@/components/wallet-provider";
import { Nav } from "@/components/nav";

const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display", weight: ["500", "700"] });
const body = Inter({ subsets: ["latin"], variable: "--font-body" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "Foundry — memecoin launchpad",
  description: "Launch a memecoin. Stake FOUNDRY, earn 25% of platform fees. Hold a launch, earn from its own supply.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body className="font-body min-h-screen">
        <SolanaProvider>
          <div className="flex min-h-screen">
            <Nav />
            <main className="page-shell flex-1 min-w-0 overflow-hidden">{children}</main>
          </div>
        </SolanaProvider>
      </body>
    </html>
  );
}
