import type { ReactNode } from "react";
import { RequireAuth } from "@/components/auth/require-auth.tsx";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>;
}
