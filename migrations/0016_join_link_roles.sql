-- The role an account made from a standing join link gets (FR-USR-40): 'user' is Staff, 'outreach'
-- is a worker from another organization. Every existing link made Staff accounts, and still does.
ALTER TABLE join_links ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
