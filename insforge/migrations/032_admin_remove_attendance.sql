-- ══════════════════════════════════════════════════════════════════════
-- 032_admin_remove_attendance.sql
-- حذف حضور طالب فعليًا من جلسة — يظهر للإدمن زر حذف في كشف حضور الجلسة.
-- الحذف فعلي (DELETE من attendance_logs) لذا:
--   • الفصل/المحاضرة تُحتسب على الطالب كلَّ غياب تلقائيًا في كل الكشوفات
--     (النسبة، المادة ٣٥، كشف السرّ…) لأن كل شيء يُحسب من attendance_logs.
--   • لوحة الطالب و«المحاضرات المسجلة» عنده تتحدث فورًا لأن القراءة حية.
-- الصلاحية: أدمن المادة (is_subject_admin_for) أو المشرف العام فقط.
-- ──────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.admin_remove_attendance(UUID);

CREATE OR REPLACE FUNCTION public.admin_remove_attendance(p_attendance_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_log RECORD;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_admin', 'error', 'غير مصرح — هذه العملية للأدمن فقط');
  END IF;

  SELECT al.id, al.session_id, al.student_id,
         ls.subject_id,
         st.full_name_ar, st.national_id,
         ls.subject_id AS session_subject_id
  INTO v_log
  FROM public.attendance_logs al
  JOIN public.lecture_sessions ls ON ls.id = al.session_id
  JOIN public.students st ON st.id = al.student_id
  WHERE al.id = p_attendance_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_found', 'error', 'سجل الحضور غير موجود (ربما حُذف بالفعل)');
  END IF;

  IF NOT public.is_subject_admin_for(auth.uid(), v_log.subject_id) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'forbidden',
      'error', 'غير مصرح — هذه المادة ليست ضمن مسؤوليتك');
  END IF;

  DELETE FROM public.attendance_logs WHERE id = p_attendance_id;

  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), 'admin_remove_attendance', 'attendance_logs', p_attendance_id,
    jsonb_build_object(
      'student_id', v_log.student_id,
      'session_id', v_log.session_id,
      'subject_id', v_log.subject_id,
      'student_name', v_log.full_name_ar,
      'national_id', v_log.national_id
    ));

  RETURN jsonb_build_object('ok', TRUE, 'student_name', v_log.full_name_ar,
    'message', 'تم حذف حضور الطالب فعليًا — سيُحتسب غيابًا في كل الكشوفات');
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_remove_attendance(UUID) TO authenticated;
