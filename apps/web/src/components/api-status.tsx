"use client";

import { HealthResponse } from "@stego/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api.ts";

export function ApiStatus() {
  const { data, isPending, isError } = useQuery({
    queryKey: ["health"],
    queryFn: () => apiGet("/api/health", HealthResponse),
  });

  const label = isPending ? "checking…" : isError ? "unreachable" : `ok (v${data.version})`;
  return <p className="text-sm text-neutral-500">API: {label}</p>;
}
