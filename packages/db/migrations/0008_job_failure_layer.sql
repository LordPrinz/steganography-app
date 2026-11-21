-- Which layer of a layered embedding made the job fail (0 to 2, the index in the request), for a
-- capacity or layer conflict error. Null for every other failure.
ALTER TABLE jobs ADD COLUMN failure_layer smallint;
ALTER TABLE jobs ADD CONSTRAINT jobs_failure_layer_chk CHECK (failure_layer BETWEEN 0 AND 2);
