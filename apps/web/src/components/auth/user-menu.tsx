"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleUser, LogOut } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { replaceSession, useSession } from "@/hooks/use-session.ts";
import { apiPost } from "@/lib/api.ts";

export function UserMenu() {
  const { data: user, isPending } = useSession();
  const queryClient = useQueryClient();

  const signOut = useMutation({
    mutationFn: () => apiPost("/api/v1/auth/logout"),
    // Even if the request failed the cookies may be gone. Dropping the session sends guarded pages to sign-in.
    onSettled: () => {
      replaceSession(queryClient, null);
    },
  });

  if (isPending) return <Skeleton className="h-8 w-20" />;

  if (!user) {
    return (
      <div className="flex items-center gap-1">
        <Button asChild variant="ghost" size="sm">
          <Link href="/sign-in">Sign in</Link>
        </Button>
        <Button asChild size="sm">
          <Link href="/sign-up">Sign up</Link>
        </Button>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu">
          <CircleUser />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
          {user.email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={signOut.isPending} onSelect={() => signOut.mutate()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
