-- 007_admin_set_user_password.sql
-- Sets a user's password server-side using bcrypt (cost 10), the same format
-- auth.users already stores. The InsForge SDK (1.5.x) exposes no admin API to
-- update a user's password, so the student-update-password edge function calls
-- this SECURITY DEFINER RPC instead.
--
-- The RPC is intentionally NOT granted to anon/authenticated: only the service
-- (API key) role can execute it. The edge function performs its own
-- authorization checks (the reset request must exist, belong to the caller and
-- be approved) before invoking this function.

CREATE OR REPLACE FUNCTION public.admin_set_user_password(p_user_id UUID, p_new_password TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير محدد';
  END IF;
  IF length(p_new_password) < 8 THEN
    RAISE EXCEPTION 'كلمة المرور غير مستوفية للشروط';
  END IF;

  UPDATE auth.users
     SET password = crypt(p_new_password, gen_salt('bf', 10)), updated_at = now()
   WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'المستخدم غير موجود';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_user_password(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_user_password(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.admin_set_user_password(UUID, TEXT) FROM authenticated;
