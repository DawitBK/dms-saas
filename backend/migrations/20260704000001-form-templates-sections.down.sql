-- Reverts 20260704000001-form-templates-sections.sql. Safe: a single
-- nullable JSONB column, purely additive — nothing else depends on it
-- existing at the database level. Any field-grouping metadata authored into
-- sections_json is lost on rollback, which is expected (the app code that
-- reads it, the template builder's section grouping, is also being rolled
-- back — templates simply go back to rendering all fields under one implicit
-- "General" section, exactly as they did before this column existed).
ALTER TABLE form_templates DROP COLUMN IF EXISTS sections_json;
