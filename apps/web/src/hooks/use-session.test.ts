import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { replaceSession, SESSION_KEY } from "./use-session.ts";

test("replaceSession drops data cached for the previous user", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["/api/v1/images"], [{ id: "a" }]);
  const user = { id: "u", email: "b@example.com", createdAt: "2026-01-01T00:00:00.000Z" };

  replaceSession(queryClient, user);

  expect(queryClient.getQueryData(["/api/v1/images"])).toBeUndefined();
  expect(queryClient.getQueryData(SESSION_KEY)).toEqual(user);
});

test("replaceSession(null) signs out and clears the cache", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["x"], 1);
  replaceSession(queryClient, null);
  expect(queryClient.getQueryData(["x"])).toBeUndefined();
  expect(queryClient.getQueryData(SESSION_KEY)).toBeNull();
});
