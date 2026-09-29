-- 008_admin_purge_student.sql
-- Permanent student removal. Deleting auth.users cascades to students,
-- attendance_logs, student_subjects, webauthn_credentials/challenges and
-- password_reset_requests, but two tables use NO ACTION and must be handled
-- explicitly first:
--   * national_ids.claimed_by  -> free the national id so it can be claimed again
--   * audit_logs.actor_id      -> remove this student's audit rows (or the user
--                                delete is blocked by the NO ACTION foreign key)
-- Only the API-key/service role can execute this (revoked from anon/authenticated);
-- the caller must be a verified admin, checked via p_admin_id.

CREATE OR REPLACE FUNCTION public.admin_purge_student(p_student_id UUID, p_admin_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_national_id VARCHAR;
BEGIN
  IF NOT public.is_admin(p_admin_id) THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  SELECT national_id INTO v_national_id
  FROM public.students
  WHERE id = p_student_id;

  -- حرّر الرقم القومي من القائمة المسموح بها ليسمح لطالب آخر بالتسجيل به
  IF v_national_id IS NOT NULL THEN
    UPDATE public.national_ids
       SET is_claimed = false, claimed_by = NULL
     WHERE claimed_by = p_student_id OR national_id = v_national_id;
  END IF;

  -- سجلات التدقيق الخاصة بالطالب (FK من نوع NO ACTION على auth.users)
  DELETE FROM public.audit_logs WHERE actor_id = p_student_id;

  -- حذف المستخدم نهائيًا; CASCADE يتكفل بالباقي
  DELETE FROM auth.users WHERE id = p_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الطالب غير موجود أو تم حذفه بالفعل';
  END IF;

  RETURN v_national_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_purge_student(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_purge_student(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.admin_purge_student(UUID, UUID) FROM authenticated;
