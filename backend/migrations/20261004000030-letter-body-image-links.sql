-- Letters L13: body images were checked by TENANT only. Anyone holding letter:read could fetch any
-- image of the tenant by id, and a letter body could embed (and the final PDF would then render) an
-- image another user uploaded, because nothing tied an image to the letters that use it.
--
-- letter_body_image_links says which letters embed which image. The service now
--   * refuses to save a letter body that names an image the saving user did not upload, and
--   * serves an image only to its uploader or to someone who may read a letter that embeds it.
-- Insert-only: an image dropped from the latest body stays linked, because an older revision of the
-- same letter may still show it.
--
-- Back-fill (SQL, below): scans every letter body and every revision for image ids and links the
-- ones the LETTER'S OWN AUTHOR uploaded. An image that appears in a letter but was uploaded by
-- somebody else is deliberately NOT linked: that is exactly the exposure being closed, so such an
-- image stops rendering/serving rather than being legitimised. Idempotent.
-- SAFE: brand-new table, nothing depends on it yet; no existing row is altered or removed.
CREATE TABLE IF NOT EXISTS letter_body_image_links (
  image_id    UUID         NOT NULL REFERENCES letter_body_images(id) ON DELETE CASCADE,
  letter_id   UUID         NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
  tenant_id   VARCHAR(100) NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (image_id, letter_id)
);

CREATE INDEX IF NOT EXISTS letter_body_image_links_letter_idx ON letter_body_image_links (letter_id);
CREATE INDEX IF NOT EXISTS letter_body_image_links_tenant_idx ON letter_body_image_links (tenant_id);

-- Same RLS pattern as letter_body_images / letter_attachments.
ALTER TABLE letter_body_image_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS letter_body_image_links_tenant_isolation ON letter_body_image_links;
CREATE POLICY letter_body_image_links_tenant_isolation ON letter_body_image_links
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (
    tenant_id = nullif(current_setting('app.current_tenant', true), '')
  );

-- Back-fill from the current body and from every saved revision.
INSERT INTO letter_body_image_links (image_id, letter_id, tenant_id)
SELECT DISTINCT img.id, l.id, l.tenant_id
  FROM letters l
  CROSS JOIN LATERAL regexp_matches(coalesce(l.body_html, ''), '/letters/body-images/([0-9a-fA-F-]{36})', 'g') AS m(ref)
  JOIN letter_body_images img
    ON img.id::text = lower(m.ref[1])
   AND img.tenant_id = l.tenant_id
   AND img.uploaded_by = l.created_by
ON CONFLICT DO NOTHING;

INSERT INTO letter_body_image_links (image_id, letter_id, tenant_id)
SELECT DISTINCT img.id, l.id, l.tenant_id
  FROM letter_revisions r
  JOIN letters l ON l.id = r.letter_id
  CROSS JOIN LATERAL regexp_matches(coalesce(r.body_html, ''), '/letters/body-images/([0-9a-fA-F-]{36})', 'g') AS m(ref)
  JOIN letter_body_images img
    ON img.id::text = lower(m.ref[1])
   AND img.tenant_id = l.tenant_id
   AND img.uploaded_by = l.created_by
ON CONFLICT DO NOTHING;
