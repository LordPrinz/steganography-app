import type { LucideIcon } from "lucide-react";
import { FlaskConical, History, Images, LockKeyhole, ScanSearch } from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
};

export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: "/encode",
    label: "Encode",
    description: "Hide a message in an image with LSB, DCT or DWT.",
    icon: LockKeyhole,
  },
  {
    href: "/decode",
    label: "Decode",
    description: "Reveal a message hidden in a stego image.",
    icon: ScanSearch,
  },
  {
    href: "/lab",
    label: "Lab",
    description: "Measure how hidden data survives JPEG, resizing and blur.",
    icon: FlaskConical,
  },
  {
    href: "/gallery",
    label: "Gallery",
    description: "Your uploaded cover and stego images.",
    icon: Images,
  },
  {
    href: "/history",
    label: "History",
    description: "Past encode, decode and lab runs.",
    icon: History,
  },
];

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
