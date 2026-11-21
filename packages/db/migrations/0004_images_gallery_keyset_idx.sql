-- The gallery pages through a user's images newest first, keyset on (created_at, id). This index serves
-- both the ORDER BY and the row comparison; it also covers the old (user_id, created_at) lookups.
DROP INDEX images_user_idx;
CREATE INDEX images_user_gallery_idx ON images (user_id, created_at DESC, id DESC);
