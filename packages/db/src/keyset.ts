/**
 * Position in a newest-first listing. `createdAt` is a full-precision ISO timestamp: Postgres keeps
 * microseconds, a JS Date only milliseconds, and a rounded cursor would skip or repeat rows.
 */
export interface KeysetCursor {
  createdAt: string;
  id: string;
}
