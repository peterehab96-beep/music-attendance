-- 017_fix_execute_attendance_law.sql
-- إصلاح خطأ SQL في execute_attendance_law: كان يخلط COUNT (aggregate) مع عمود
-- من CROSS JOIN بدون GROUP BY مما يرفع "column c.total must appear in GROUP BY".
-- الحل: استعلامان قياسيان منفصلان (subquery) بدل الاستعلام المختلط.

CREATE OR REPLACE FUNCTION public.execute_attendance_law(
  p_student_id UUID, p_subject_id UUID
)
RETURNS TABLE (action_type TEXT, action_number INTEGER, deducted_grade NUMERIC, is_banned BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_attended BIGINT; v_total BIGINT; v_percent NUMERIC;
  v_warn INTEGER; v_ded INTEGER; v_ban INTEGER;
  v_next INTEGER; v_max_grade SMALLINT; v_current NUMERIC;
  v_new_grade NUMERIC; v_action TEXT;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.student_subjects ss
                 WHERE ss.student_id = p_student_id AND ss.subject_id = p_subject_id
                   AND ss.status IN ('active', 'parallel')) THEN
    RAISE EXCEPTION 'الطالب غير مسجل في هذه المادة';
  END IF;

  SELECT
    (SELECT COUNT(DISTINCT al.session_id)
     FROM public.attendance_logs al
     JOIN public.lecture_sessions ls ON ls.id = al.session_id
     WHERE ls.subject_id = p_subject_id AND ls.closed_at IS NOT NULL
       AND al.student_id = p_student_id),
    (SELECT COUNT(*)
     FROM public.lecture_sessions ls
     WHERE ls.subject_id = p_subject_id AND ls.closed_at IS NOT NULL)
  INTO v_attended, v_total;
  v_percent := CASE WHEN v_total = 0 THEN 100 ELSE ROUND(v_attended::NUMERIC * 100 / v_total, 1) END;

  SELECT
    COALESCE(COUNT(*) FILTER (WHERE attendance_law_actions.action_type = 'warning'), 0),
    COALESCE(COUNT(*) FILTER (WHERE attendance_law_actions.action_type = 'deduction'), 0),
    COALESCE(COUNT(*) FILTER (WHERE attendance_law_actions.action_type = 'ban'), 0)
  INTO v_warn, v_ded, v_ban
  FROM public.attendance_law_actions
  WHERE student_id = p_student_id AND subject_id = p_subject_id;

  v_next := v_warn + v_ded + 1; -- الإجراء التالي في التسلسل

  IF v_next <= 2 THEN
    v_action := 'warning';
    INSERT INTO public.attendance_law_actions
      (student_id, subject_id, action_type, action_number, attendance_count, total_sessions, attendance_percent, executed_by)
    VALUES
      (p_student_id, p_subject_id, 'warning', v_next, v_attended, v_total, v_percent, auth.uid())
    ON CONFLICT (student_id, subject_id, action_number) DO NOTHING;
    RETURN QUERY SELECT v_action, v_next, NULL::NUMERIC, FALSE;
    RETURN;
  END IF;

  -- من الإجراء الثالث فصاعدًا: خصم درجة كاملة + حالة حرمان (ban)
  v_action := 'deduction';
  SELECT s.max_grade INTO v_max_grade FROM public.subjects s WHERE s.id = p_subject_id;
  SELECT ss.year_work_grade INTO v_current
  FROM public.student_subjects ss
  WHERE ss.student_id = p_student_id AND ss.subject_id = p_subject_id;
  v_new_grade := GREATEST(COALESCE(v_current, v_max_grade::NUMERIC, 0) - 1, 0);

  UPDATE public.student_subjects
  SET year_work_grade = v_new_grade
  WHERE student_id = p_student_id AND subject_id = p_subject_id;

  INSERT INTO public.attendance_law_actions
    (student_id, subject_id, action_type, action_number, attendance_count, total_sessions, attendance_percent, deducted_grade, executed_by)
  VALUES
    (p_student_id, p_subject_id, 'deduction', v_next, v_attended, v_total, v_percent, 1, auth.uid())
  ON CONFLICT (student_id, subject_id, action_number) DO NOTHING;

  IF v_ban = 0 THEN
    INSERT INTO public.attendance_law_actions
      (student_id, subject_id, action_type, action_number, attendance_count, total_sessions, attendance_percent, executed_by)
    VALUES
      (p_student_id, p_subject_id, 'ban', v_next, v_attended, v_total, v_percent, auth.uid())
    ON CONFLICT (student_id, subject_id, action_number) DO NOTHING;
  END IF;

  RETURN QUERY SELECT v_action, v_next, 1::NUMERIC, TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION public.execute_attendance_law(UUID, UUID) TO authenticated;
