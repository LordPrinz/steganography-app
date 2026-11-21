"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useSession } from "@/hooks/use-session.ts";
import { signInHref } from "@/lib/return-path.ts";

/**
 * Keeps signed-out visitors off app pages. The auth cookies only travel to /api/v1, so the server
 * cannot see them when rendering a page; the check happens here, against `GET /auth/me`.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const signedOut = session.data === null;

  useEffect(() => {
    if (signedOut) router.replace(signInHref(`${pathname}${window.location.search}`));
  }, [signedOut, router, pathname]);

  if (session.data) return children;

  if (session.isError) {
    return (
      <Alert variant="destructive" role="alert" className="flex flex-wrap items-center gap-3">
        Could not check your session.
        <Button variant="outline" size="sm" onClick={() => session.refetch()}>
          Try again
        </Button>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
