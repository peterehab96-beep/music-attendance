-- 031_fix_admin_add_retro_attendance.sql
DROP FUNCTION IF EXISTS public.admin_add_retro_attendance(UUID, VARCHAR);

CREATE OR REPLACE FUNCTION public.admin_add_retro_attendance(p_session_id UUID, p_national_id VARCHAR)
RETURNS TABLE (
  ok BOOLEAN, code TEXT, error TEXT, already_present BOOLEAN,
  student_id UUID, student_name TEXT, national_id VARCHAR,
  attendance_id UUID, checked_in_at TIMESTAMPTZ, message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth AS $$
#variable_conflict use_column
DECLARE
  v_session public.lecture_sessions%ROWTYPE;
  v_student public.students%ROWTYPE;
  v_existing UUID;
  v_id UUID;
  v_nid TEXT;
  v_checked_at TIMESTAMPTZ;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  SELECT * INTO v_session FROM public.lecture_sessions ls WHERE ls.id = p_session_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'not_found'::TEXT, 'الجلسة غير موجودة'::TEXT, FALSE, NULL::UUID, NULL::TEXT, NULL::VARCHAR, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT;
    RETURN;
  END IF;

  IF NOT public.is_subject_admin_for(auth.uid(), v_session.subject_id) THEN
    RETURN QUERY SELECT FALSE, 'forbidden'::TEXT, 'غير مصرح — هذه المادة ليست ضمن مسؤوليتك'::TEXT, FALSE, NULL::UUID, NULL::TEXT, NULL::VARCHAR, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT;
    RETURN;
  END IF;

  v_nid := regexp_replace(COALESCE(p_national_id, ''), '[^0-9]', '', 'g');
  IF v_nid !~ '^(\d{6,9}|\d{14})$' THEN
    RETURN QUERY SELECT FALSE, 'invalid_nid'::TEXT, 'الرقم القومي غير صالح'::TEXT, FALSE, NULL::UUID, NULL::TEXT, NULL::VARCHAR, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_student FROM public.students st WHERE st.national_id = v_nid;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'not_found'::TEXT, 'لا يوجد طالب بهذا الرقم'::TEXT, FALSE, NULL::UUID, NULL::TEXT, NULL::VARCHAR, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.student_subjects ss
    WHERE ss.student_id = v_student.id AND ss.subject_id = v_session.subject_id
  ) THEN
    RETURN QUERY SELECT FALSE, 'not_enrolled'::TEXT, ('الطالب ' || v_student.full_name_ar || ' غير مسجل في مادة هذه الجلسة')::TEXT, FALSE, NULL::UUID, NULL::TEXT, NULL::VARCHAR, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT;
    RETURN;
  END IF;

  SELECT al.id INTO v_existing FROM public.attendance_logs al
  WHERE al.session_id = p_session_id AND al.student_id = v_student.id
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT TRUE, 'already'::TEXT, NULL::TEXT, TRUE, v_student.id, v_student.full_name_ar, v_student.national_id, v_existing, NULL::TIMESTAMPTZ, 'كان مسجلًا في هذه الجلسة بالفعل'::TEXT;
    RETURN;
  END IF;

  v_checked_at := COALESCE(v_session.closed_at, v_session.opened_at, now());

  INSERT INTO public.attendance_logs (session_id, student_id, checked_in_at, check_in_method)
  VALUES (p_session_id, v_student.id, v_checked_at, 'manual_admin')
  ON CONFLICT (session_id, student_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT al.id INTO v_id FROM public.attendance_logs al WHERE al.session_id = p_session_id AND al.student_id = v_student.id LIMIT 1;
  END IF;

  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), 'admin_add_retro_attendance', 'attendance_logs', v_id,
    jsonb_build_object('student_id', v_student.id, 'session_id', p_session_id));

  RETURN QUERY SELECT TRUE, 'ok'::TEXT, NULL::TEXT, FALSE, v_student.id, v_student.full_name_ar, v_student.national_id, v_id, v_checked_at, 'تم تسجيل حضوره بوقت الجلسة'::TEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_add_retro_attendance(UUID, VARCHAR) TO authenticated;
