-- 015_attendance_law35.sql
-- المادة (٣٥) حضور ومواظبة الطلاب وحرمانهم أو إلغاء قيدهم:
-- الحد الأدنى 75% حضور من المحاضرات المحددة للمقرر، ومن يقل عنها يُحرم من دخول
-- الامتحان النهائي ويُعد راسبًا ويُرصد له تقدير (حرمان).
-- آلية النظام: عند تنفيذ القانون يُصدر إنذار أول/ثاني، ثم عند الثالثة يُخصم
-- درجة كاملة من درجة أعمال السنة السرية كل مرة، ويظهر للطالب تنبيه الحرمان فقط
-- مع نص المادة — دون إفصاحه عن أي خصم في الدرجات.

CREATE TABLE IF NOT EXISTS public.attendance_law_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('warning', 'deduction', 'ban')),
  action_number INTEGER NOT NULL DEFAULT 1 CHECK (action_number BETWEEN 1 AND 3),
  attendance_count INTEGER NOT NULL DEFAULT 0,
  total_sessions INTEGER NOT NULL DEFAULT 0,
  attendance_percent NUMERIC NOT NULL DEFAULT 0,
  deducted_grade NUMERIC,
  executed_by UUID REFERENCES public.admins(id) ON DELETE SET NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, subject_id, action_number)
);

ALTER TABLE public.attendance_law_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS law_actions_admin_all ON public.attendance_law_actions;
CREATE POLICY law_actions_admin_all ON public.attendance_law_actions
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS law_actions_student_read ON public.attendance_law_actions;
CREATE POLICY law_actions_student_read ON public.attendance_law_actions
  FOR SELECT USING (auth.uid() = student_id);

GRANT SELECT ON public.attendance_law_actions TO authenticated;

-- حساب الالتزام بالحضور لكل طالب في كل مادة مسجلة له.
-- محاضرات المادة = عدد الجلسات المغلقة للمادة، والحضور = الجلسات المسجل بها.
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
      COUNT(*) FILTER (WHERE a.action_type = 'deduction')::INTEGER AS ded,
      COUNT(*) FILTER (WHERE a.action_type = 'ban')::INTEGER AS ban
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
    COALESCE(a.ban, 0) > 0,
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

-- تنفيذ القانون على (طالب، مادة):
-- 1) إنذار أول  2) إنذار ثانٍ  3) وأكثر: خصم درجة كاملة من أعمال السنة السرية
--    + إصدار "حرمان" يظهر للطالب فقط باسم المادة ونص المادة ٣٥.
-- يعيد إجراء اليوم حتى يعرف المدير ماذا تم فعله فعلًا.
CREATE OR REPLACE FUNCTION public.execute_attendance_law(
  p_student_id UUID, p_subject_id UUID
)
RETURNS TABLE (action_type TEXT, action_number INTEGER, deducted_grade NUMERIC, is_banned BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  SELECT COALESCE(COUNT(DISTINCT al.session_id), 0), COALESCE(c.total, 0)
  INTO v_attended, v_total
  FROM public.lecture_sessions ls
  LEFT JOIN public.attendance_logs al ON al.session_id = ls.id AND al.student_id = p_student_id
  CROSS JOIN (SELECT COUNT(*) AS total FROM public.lecture_sessions ls2 WHERE ls2.subject_id = p_subject_id AND ls2.closed_at IS NOT NULL) c
  WHERE ls.subject_id = p_subject_id AND ls.closed_at IS NOT NULL;
  v_percent := CASE WHEN v_total = 0 THEN 100 ELSE ROUND(v_attended::NUMERIC * 100 / v_total, 1) END;

  SELECT
    COALESCE(COUNT(*) FILTER (WHERE action_type = 'warning'), 0),
    COALESCE(COUNT(*) FILTER (WHERE action_type = 'deduction'), 0),
    COALESCE(COUNT(*) FILTER (WHERE action_type = 'ban'), 0)
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

-- حالة الطالب: هل هو محروم في أي مادة؟ وما عدد إنذاراته؟
-- يعيد اسم المادة المحروم فيها فقط (دون أي تفاصيل درجات) لنص التنبيه.
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
           COUNT(*) FILTER (WHERE a.action_type = 'ban')::INTEGER AS ban
    FROM public.attendance_law_actions a
    WHERE a.student_id = v_student
    GROUP BY a.subject_id
  )
  SELECT
    s.id, s.name_ar,
    CASE WHEN COALESCE(c.total, 0) = 0 THEN 100::NUMERIC
         ELSE ROUND(COALESCE(c.attended, 0)::NUMERIC * 100 / c.total, 1) END,
    COALESCE(a.warn, 0),
    COALESCE(a.ban, 0) > 0
  FROM public.student_subjects ss
  JOIN public.subjects s ON s.id = ss.subject_id
  LEFT JOIN counts c ON c.sid = s.id
  LEFT JOIN actions a ON a.asub = s.id
  WHERE ss.student_id = v_student AND ss.status IN ('active', 'parallel')
    AND (COALESCE(a.ban, 0) > 0 OR COALESCE(a.warn, 0) > 0
         OR (COALESCE(c.total, 0) > 0 AND COALESCE(c.attended, 0)::NUMERIC * 100 / c.total < 75))
  ORDER BY s.name_ar;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_attendance_status() TO authenticated;

-- إلغاء الإجراءات (تراجع): يحذف إجراءات المادة لهذا الطالب ويستعيد الدرجة
-- المحسومة على أساس أعمال السنة الأصلية المسجلة يدويًا قبل الخصم إن وجدت.
CREATE OR REPLACE FUNCTION public.undo_attendance_law(p_student_id UUID, p_subject_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  DELETE FROM public.attendance_law_actions
  WHERE student_id = p_student_id AND subject_id = p_subject_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.undo_attendance_law(UUID, UUID) TO authenticated;
