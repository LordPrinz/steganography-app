import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page.tsx";
import { NAV_ITEMS } from "@/lib/nav.ts";

export const metadata: Metadata = { title: "Gallery" };

const item = NAV_ITEMS.find((i) => i.href === "/gallery");

export default function GalleryPage() {
  return <PlaceholderPage title="Gallery" description={item?.description ?? ""} />;
}
