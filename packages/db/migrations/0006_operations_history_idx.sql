-- The history pages through a user's operations newest first, keyset on (created_at, id). The index serves
-- the ORDER BY and the row comparison; the type, method and status filters are checked on the rows it
-- walks, which stay within one user's history. It also covers the old (user_id, created_at) lookups.
DROP INDEX operations_user_idx;
CREATE INDEX operations_user_history_idx ON operations (user_id, created_at DESC, id DESC);
