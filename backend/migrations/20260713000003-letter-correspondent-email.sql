-- CAMS: an actual email address to send the finished letter (or its
-- registration) to, distinct from correspondent/correspondent_organization
-- (which are just display names). Optional — dispatch falls back to a
-- physical/print channel when the recipient has no email or doesn't accept
-- digital correspondence.
ALTER TABLE letters ADD COLUMN IF NOT EXISTS correspondent_email TEXT;
