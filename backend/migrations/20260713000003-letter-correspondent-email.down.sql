-- Reverts 20260713000003-letter-correspondent-email.sql. Safe: purely
-- additive nullable column, nothing else references it.
ALTER TABLE letters DROP COLUMN IF EXISTS correspondent_email;
