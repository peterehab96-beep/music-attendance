-- 013_fix_lecture_sessions_select_grant.sql
-- The lecture_sessions table was missing the table-level SELECT privilege for
-- anon/authenticated (it only had INSERT/UPDATE/DELETE), so every read of the
-- admin Sessions page failed with "permission denied for table lecture_sessions"
-- even though the RLS SELECT policy existed. RLS policies never take effect
-- without the underlying table privilege.

GRANT SELECT ON TABLE public.lecture_sessions TO anon, authenticated;
