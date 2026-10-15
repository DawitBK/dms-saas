-- A template's base file (basePdfObjectKey) has always meant "a pre-printed
-- form/scan whose own captions are already on the page" — generateFormPdf
-- (forms.service.ts) skips drawing synthetic field labels whenever a base
-- file is set, on that assumption. A branding-only letterhead (header/footer
-- banner, no field captions at all) needs the opposite: labels DO need to be
-- drawn, and the usable content area needs to sit clear of the header/footer
-- bands rather than spanning the full page. is_letterhead distinguishes the
-- two base-file kinds; existing templates default to false, preserving
-- today's "any base file = pre-printed, don't draw labels, full-page layout"
-- behavior exactly.
ALTER TABLE form_templates
  ADD COLUMN IF NOT EXISTS is_letterhead BOOLEAN NOT NULL DEFAULT false;
