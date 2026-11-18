"use client";

import { HealthResponse } from "@stego/contracts";
import { Badge } from "@/components/ui/badge.tsx";
import { useApiQuery } from "@/hooks/use-api-query.ts";

export function ApiStatus() {
  const { data, isPending, isError } = useApiQuery("/api/v1/health", HealthResponse, {
    retry: false,
  });

  if (isPending) return <Badge variant="outline">API: checking…</Badge>;
  if (isError) return <Badge variant="destructive">API: unreachable</Badge>;
  return <Badge variant="secondary">API: ok (v{data.version})</Badge>;
}
