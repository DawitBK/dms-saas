-- Reverts 20260921000001-letter-correspondent-location.sql. Safe: purely
-- additive nullable column, nothing else references it.
ALTER TABLE letters DROP COLUMN IF EXISTS correspondent_location;
