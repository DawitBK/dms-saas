-- CAMS: per-unit letterhead. Sister companies under the Example Corp umbrella
-- issue correspondence under their own name — the letter/cover-sheet PDFs
-- previously hardcoded "EXAMPLE CORP" as the masthead for every unit.
-- NULL keeps the group-level default.

ALTER TABLE org_units ADD COLUMN IF NOT EXISTS letterhead_title VARCHAR(120) NULL;
