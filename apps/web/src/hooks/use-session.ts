"use client";

import { AuthResponse, type AuthUser } from "@stego/contracts";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { ApiRequestError, apiGet } from "@/lib/api.ts";

export const SESSION_KEY = ["session"] as const;

/**
 * Switches the cached session. Everything else cached belongs to the previous user (or to nobody),
 * so it is dropped first; otherwise the next user in this tab could see it.
 */
export function replaceSession(queryClient: QueryClient, user: AuthUser | null): void {
  queryClient.clear();
  queryClient.setQueryData(SESSION_KEY, user);
}

/** The signed-in user: `undefined` while loading, `null` when signed out. */
export function useSession() {
  return useQuery<AuthUser | null>({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      try {
        return (await apiGet("/api/v1/auth/me", AuthResponse)).user;
      } catch (error) {
        // apiGet already tried a refresh; a 401 here means nobody is signed in.
        if (error instanceof ApiRequestError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}
