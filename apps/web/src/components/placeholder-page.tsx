"use client";

import { ReadinessResponse } from "@stego/contracts";
import { Construction } from "lucide-react";
import { PageHeader } from "@/components/page-header.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useApiQuery } from "@/hooks/use-api-query.ts";

/** Stand-in for a route that is not built yet; shows that the page can already talk to the API. */
export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} description={description} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Construction className="size-4" />
              Coming soon
            </CardTitle>
            <CardDescription>This page is a placeholder in the app shell.</CardDescription>
          </CardHeader>
        </Card>
        <BackendCard />
      </div>
    </div>
  );
}

function BackendCard() {
  const { data, isPending, isError, error } = useApiQuery(
    "/api/v1/health/ready",
    ReadinessResponse,
    { retry: false },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Backend</CardTitle>
        <CardDescription>Fetched with apiGet from /api/v1/health/ready.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 text-sm">
        {isPending ? (
          <Skeleton className="h-5 w-32" />
        ) : isError ? (
          <Badge variant="destructive">{error.message || "unavailable"}</Badge>
        ) : (
          <>
            <Badge variant={data.status === "ready" ? "secondary" : "destructive"}>
              {data.status}
            </Badge>
            <span className="text-muted-foreground">Redis: {data.checks.redis}</span>
          </>
        )}
      </CardContent>
    </Card>
  );
}
