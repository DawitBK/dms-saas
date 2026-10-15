-- Forms engine: named field sections for the template builder.
--
-- sections_json: [{id, label, order}], sibling metadata to schema_json's field
-- array — kept separate so pdfme's generate() (which only reads schema_json)
-- never has to be aware of grouping. Nullable; existing templates render all
-- fields under one implicit "General" section when null.

ALTER TABLE form_templates ADD COLUMN IF NOT EXISTS sections_json JSONB;
