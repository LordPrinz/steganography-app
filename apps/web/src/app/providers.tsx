"use client";

import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { type ReactNode, useState } from "react";
import { SESSION_KEY } from "@/hooks/use-session.ts";
import { ApiRequestError } from "@/lib/api.ts";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          // A 401 that survived the refresh means the session is gone; route guards react to that.
          onError: (error) => {
            if (error instanceof ApiRequestError && error.status === 401) {
              queryClient.setQueryData(SESSION_KEY, null);
            }
          },
        }),
      }),
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ThemeProvider>
  );
}
