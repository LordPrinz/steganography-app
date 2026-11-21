import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page.tsx";
import { NAV_ITEMS } from "@/lib/nav.ts";

export const metadata: Metadata = { title: "Lab" };

const item = NAV_ITEMS.find((i) => i.href === "/lab");

export default function LabPage() {
  return <PlaceholderPage title="Lab" description={item?.description ?? ""} />;
}
