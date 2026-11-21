-- Set when a refresh token is rotated, so presenting it again can be told apart from a token that was
-- revoked by logout: reuse after rotation means it leaked, and the whole session family is revoked.
ALTER TABLE refresh_tokens
  ADD COLUMN replaced_by uuid REFERENCES refresh_tokens (id) ON DELETE SET NULL;
-- Serves the ON DELETE SET NULL lookup when a user's tokens are deleted.
CREATE INDEX refresh_tokens_replaced_by_idx ON refresh_tokens (replaced_by);
