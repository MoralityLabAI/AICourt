import type { Metadata } from "next";
import CourtReplay from "./CourtReplay";

export const metadata: Metadata = {
  title: "Court Replay Desk",
  description: "Inspect multi-agent Court episodes as an animated pixel-art stage, readable strategy diary, and engine-resolved commitment ledger."
};

export default function Home() {
  return <CourtReplay />;
}
