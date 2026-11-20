import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page.tsx";
import { NAV_ITEMS } from "@/lib/nav.ts";

export const metadata: Metadata = { title: "History" };

const item = NAV_ITEMS.find((i) => i.href === "/history");

export default function HistoryPage() {
  return <PlaceholderPage title="History" description={item?.description ?? ""} />;
}
