-- Attacked images of the robustness lab ("variants") are kept for a day and then deleted by the worker.
-- Only variants expire, and every variant has an expiry.
ALTER TABLE images ADD COLUMN expires_at timestamptz;
ALTER TABLE images ADD CONSTRAINT images_variant_expiry_chk CHECK ((kind = 'variant') = (expires_at IS NOT NULL));
CREATE INDEX images_expires_idx ON images (expires_at) WHERE expires_at IS NOT NULL;

-- Variants are not part of the gallery, so its index skips them: a user's experiments leave thousands
-- of rows that the gallery query would otherwise walk past.
DROP INDEX images_user_gallery_idx;
CREATE INDEX images_user_gallery_idx ON images (user_id, created_at DESC, id DESC) WHERE kind <> 'variant';
