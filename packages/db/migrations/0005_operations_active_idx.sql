-- Counts a user's queued and running operations (the cap on active work) without scanning their history.
CREATE INDEX operations_active_idx ON operations (user_id) WHERE status IN ('queued', 'running');
