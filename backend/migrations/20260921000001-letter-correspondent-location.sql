-- CAMS: the recipient/sender's city+country line that sits under the "To:"/
-- "From:" addressee on a real Example Corp outgoing letter (e.g. "Example City,
-- Exampleland") -- previously not captured at all, so the rendered letter had
-- nowhere to put it. Optional, display-only, same shape as
-- correspondent/correspondent_organization (20260713000003).
ALTER TABLE letters ADD COLUMN IF NOT EXISTS correspondent_location TEXT;
