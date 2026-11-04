-- One job per operation: a second job would race the first on the operation's status and result.
-- The index also serves the ON DELETE CASCADE lookup from operations.
CREATE UNIQUE INDEX jobs_operation_idx ON jobs (operation_id);
