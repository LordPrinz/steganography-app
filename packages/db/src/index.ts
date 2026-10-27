import { SQL } from "bun";

export function createDb(url: string): SQL {
  return new SQL(url);
}

export type Db = SQL;
export * from "./types.ts";
