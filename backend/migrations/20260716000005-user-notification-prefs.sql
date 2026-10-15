-- L3: the settings page rendered notification-preference toggles that were
-- never persisted anywhere and never consulted by any email path — pure UI
-- theater. Give them a real home. Compliance-critical emails (retention
-- disposal warnings, trash purge notices, certificates of destruction) and
-- external-recipient emails (e-sign invites, letter dispatch) deliberately
-- ignore these preferences — only work-reminder emails are suppressible.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}';
