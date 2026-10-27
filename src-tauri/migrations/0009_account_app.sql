-- Which OAuth app an account signed in with: 'builtin' (compiled into the build) or
-- 'custom' (the one set under Settings > Advanced). Refresh tokens only work with the app
-- that issued them, so each account keeps using its own.
ALTER TABLE accounts ADD COLUMN oauth_app TEXT NOT NULL DEFAULT 'builtin';

-- Before this, a saved client ID (typed in by the user) took precedence over the built-in
-- one, so accounts of a provider with a saved ID signed in with that custom app.
UPDATE accounts SET oauth_app = 'custom'
 WHERE (provider = 'microsoft' AND EXISTS (SELECT 1 FROM settings WHERE key = 'ms_client_id' AND trim(value) <> ''))
    OR (provider = 'google' AND EXISTS (SELECT 1 FROM settings WHERE key = 'google_client_id' AND trim(value) <> ''));
