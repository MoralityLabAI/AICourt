import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Court Replay Desk",
  description: "A multi-agent strategy diary and animated event replay for Court corpus episodes.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: {
    title: "Court Replay Desk",
    description: "Watch a multi-agent succession crisis unfold, then inspect every whisper, promise, and strategy trace.",
    images: [{ url: "/og-court.png", width: 1728, height: 907, alt: "Pixel-art court factions exchange a sealed pact beneath an aging monarch." }]
  },
  twitter: { card: "summary_large_image", images: ["/og-court.png"] }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
