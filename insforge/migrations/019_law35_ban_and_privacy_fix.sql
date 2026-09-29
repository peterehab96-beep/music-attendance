-- 019_law35_ban_and_privacy_fix.sql
-- ثلاث إصلاحات لقانون ٣٥:
-- 1) الحرمان كان صفًا منفصلًا يتعارض مع صف الخصم في action_number (فريد لكل
--    طالب/مادة/رقم) فلا يُسجل أبدًا → الآن الحرمان "مشتق": وجود أي صف خصم يعني حرمانًا.
-- 2) قيد action_number BETWEEN 1 AND 3 كان يمنع الخصومات الإضافية بعد الثالثة
--    → الآن حتى 1000 (خصم تصاعدي عند كل تنفيذ جديد بعد الإنذارين).
-- 3) خصوصية الخصم: الطالب كان يقرأ جدول الإجراءات مباشرة فيرى deducted_grade
--    → أزلنا سياسة قراءة الطالب والمنح؛ الطالب يرى حالته فقط عبر
--    get_my_attendance_status (التي لا تكشف أي درجات).

ALTER TABLE public.attendance_law_actions
  DROP CONSTRAINT IF EXISTS attendance_law_actions_action_number_check;
ALTER TABLE public.attendance_law_actions
  ADD CONSTRAINT attendance_law_actions_action_number_check
  CHECK (action_number BETWEEN 1 AND 1000);

DROP POLICY IF EXISTS law_actions_student_read ON public.attendance_law_actions;
REVOKE SELECT ON public.attendance_law_actions FROM authenticated;

-- الالتزام: الحرمان = وجود خصم سابق
CREATE OR REPLACE FUNCTION public.get_attendance_compliance(p_level SMALLINT DEFAULT NULL, p_subject_id UUID DEFAULT NULL)
RETURNS TABLE (
  student_id UUID,
  student_name TEXT,
  national_id VARCHAR,
  student_status TEXT,
  level SMALLINT,
  subject_id UUID,
  subject_name TEXT,
  attended_sessions BIGINT,
  total_sessions BIGINT,
  attendance_percent NUMERIC,
  below_minimum BOOLEAN,
  warning_count INTEGER,
  deduction_count INTEGER,
  is_banned BOOLEAN,
  max_grade SMALLINT,
  current_year_work NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  RETURN QUERY
  WITH counts AS (
    SELECT
      ls.subject_id AS sid,
      COUNT(*)::BIGINT AS total,
      COUNT(DISTINCT al.session_id)::BIGINT AS attended
    FROM public.lecture_sessions ls
    LEFT JOIN public.attendance_logs al ON al.session_id = ls.id
    WHERE ls.closed_at IS NOT NULL
    GROUP BY ls.subject_id
  ),
  actions AS (
    SELECT
      a.student_id AS ast,
      a.subject_id AS asub,
      COUNT(*) FILTER (WHERE a.action_type = 'warning')::INTEGER AS warn,
      COUNT(*) FILTER (WHERE a.action_type = 'deduction')::INTEGER AS ded
    FROM public.attendance_law_actions a
    GROUP BY a.student_id, a.subject_id
  )
  SELECT
    st.id,
    st.full_name_ar,
    st.national_id,
    st.status::TEXT,
    st.level,
    s.id,
    s.name_ar,
    COALESCE(c.attended, 0),
    COALESCE(c.total, 0),
    CASE WHEN COALESCE(c.total, 0) = 0 THEN 100::NUMERIC
         ELSE ROUND(COALESCE(c.attended, 0)::NUMERIC * 100 / c.total, 1) END,
    COALESCE(c.total, 0) > 0 AND COALESCE(c.attended, 0)::NUMERIC * 100 / c.total < 75,
    COALESCE(a.warn, 0),
    COALESCE(a.ded, 0),
    COALESCE(a.ded, 0) > 0,
    s.max_grade,
    ss.year_work_grade
  FROM public.student_subjects ss
  JOIN public.students st ON st.id = ss.student_id
  JOIN public.subjects s ON s.id = ss.subject_id
  LEFT JOIN counts c ON c.sid = s.id
  LEFT JOIN actions a ON a.ast = st.id AND a.asub = s.id
  WHERE ss.status IN ('active', 'parallel')
    AND (p_level IS NULL OR st.level = p_level)
    AND (p_subject_id IS NULL OR s.id = p_subject_id)
  ORDER BY st.level, s.name_ar, st.full_name_ar;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_attendance_compliance(SMALLINT, UUID) TO authenticated;

-- تنفيذ القانون: إنذار أول، إنذار ثانٍ، ثم كل تنفيذ إضافي = خصم درجة كاملة
-- من أعمال السنة السرية + حرمان (مشتق من وجود الخصم). لا صف حرمان منفصل.
CREATE OR REPLACE FUNCTION public.execute_attendance_law(
  p_student_id UUID, p_subject_id UUID
)
RETURNS TABLE (action_type TEXT, action_number INTEGER, deducted_grade NUMERIC, is_banned BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_attended BIGINT; v_total BIGINT; v_percent NUMERIC;
  v_warn INTEGER; v_ded INTEGER;
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
    COALESCE(COUNT(*) FILTER (WHERE attendance_law_actions.action_type = 'deduction'), 0)
  INTO v_warn, v_ded
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

  -- من الإجراء الثالث فصاعدًا: خصم درجة كاملة في كل مرة + حرمان مستمر (مشتق)
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

  RETURN QUERY SELECT v_action, v_next, 1::NUMERIC, TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION public.execute_attendance_law(UUID, UUID) TO authenticated;

-- حالة الطالب: الحرمان = وجود خصم (دون كشف أي درجات)
CREATE OR REPLACE FUNCTION public.get_my_attendance_status()
RETURNS TABLE (
  subject_id UUID,
  subject_name TEXT,
  attendance_percent NUMERIC,
  warning_count INTEGER,
  is_banned BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_student UUID := auth.uid();
BEGIN
  IF v_student IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول أولًا'; END IF;
  RETURN QUERY
  WITH counts AS (
    SELECT ls.subject_id AS sid,
           COUNT(*)::BIGINT AS total,
           COUNT(DISTINCT al.session_id)::BIGINT AS attended
    FROM public.lecture_sessions ls
    LEFT JOIN public.attendance_logs al ON al.session_id = ls.id AND al.student_id = v_student
    WHERE ls.closed_at IS NOT NULL
    GROUP BY ls.subject_id
  ),
  actions AS (
    SELECT a.subject_id AS asub,
           COUNT(*) FILTER (WHERE a.action_type = 'warning')::INTEGER AS warn,
           COUNT(*) FILTER (WHERE a.action_type = 'deduction')::INTEGER AS ded
    FROM public.attendance_law_actions a
    WHERE a.student_id = v_student
    GROUP BY a.subject_id
  )
  SELECT
    s.id, s.name_ar,
    CASE WHEN COALESCE(c.total, 0) = 0 THEN 100::NUMERIC
         ELSE ROUND(COALESCE(c.attended, 0)::NUMERIC * 100 / c.total, 1) END,
    COALESCE(a.warn, 0),
    COALESCE(a.ded, 0) > 0
  FROM public.student_subjects ss
  JOIN public.subjects s ON s.id = ss.subject_id
  LEFT JOIN counts c ON c.sid = s.id
  LEFT JOIN actions a ON a.asub = s.id
  WHERE ss.student_id = v_student AND ss.status IN ('active', 'parallel')
    AND (COALESCE(a.ded, 0) > 0 OR COALESCE(a.warn, 0) > 0
         OR (COALESCE(c.total, 0) > 0 AND COALESCE(c.attended, 0)::NUMERIC * 100 / c.total < 75))
  ORDER BY s.name_ar;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_attendance_status() TO authenticated;
