"use client";

import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import { apiGet } from "@/lib/api.ts";

type Options<T> = Omit<UseQueryOptions<T>, "queryKey" | "queryFn">;

/** `useQuery` over `apiGet`: the path is the cache key and the response is validated by `schema`. */
export function useApiQuery<S extends z.ZodType>(
  path: string,
  schema: S,
  options?: Options<z.infer<S>>,
) {
  return useQuery<z.infer<S>>({
    queryKey: [path],
    queryFn: () => apiGet(path, schema),
    ...options,
  });
}
