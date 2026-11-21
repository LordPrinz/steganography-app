"use client";

import { AuthResponse, type AuthUser } from "@stego/contracts";
import { useQuery } from "@tanstack/react-query";
import { ApiRequestError, apiGet } from "@/lib/api.ts";

export const SESSION_KEY = ["session"] as const;

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
