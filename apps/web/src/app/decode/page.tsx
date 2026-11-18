import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page.tsx";
import { NAV_ITEMS } from "@/lib/nav.ts";

export const metadata: Metadata = { title: "Decode" };

const item = NAV_ITEMS.find((i) => i.href === "/decode");

export default function DecodePage() {
  return <PlaceholderPage title="Decode" description={item?.description ?? ""} />;
}
