import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page.tsx";
import { NAV_ITEMS } from "@/lib/nav.ts";

export const metadata: Metadata = { title: "Encode" };

const item = NAV_ITEMS.find((i) => i.href === "/encode");

export default function EncodePage() {
  return <PlaceholderPage title="Encode" description={item?.description ?? ""} />;
}
