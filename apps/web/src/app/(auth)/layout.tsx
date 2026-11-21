import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="flex justify-center sm:pt-8">{children}</div>;
}
