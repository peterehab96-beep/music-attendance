-- 024_law35_automation.sql
-- أتمتة المادة ٣٥ + إشعارات الطالب الفورية:
-- 1) جدول attendance_notifications: إشعار حقيقي للطالب (إنذار أول/ثانٍ/حرمان) يظهر
--    في لوحته فور إصداره — بنفس الثانية التي ينفّذ فيها الإدمن القانون، أو تلقائيًا
--    من الفحص المجدول. القيد الفريد (طالب، مادة، نوع) يجعل التنفيذ المتكرر آمنًا
--    (idempotent) فلا تتكرر الإشعارات أو الإجراءات أبدًا.
-- 2) law35_scan_rows(): نواة الحساب (قراءة فقط) — ممنوعة عن anon/authenticated
--    تمامًا؛ يستدعيها المحرك المجدول (service role) فقط.
-- 3) law35_due_plan(): خطة المستحق الآن (للواجهة — للإدمن فقط).
-- 4) law35_apply_plan(): تنفيذ المستحق فعليًا (إنذار أول، إنذار ثانٍ بعد مهلة،
--    ثم حرمان) — service role فقط.
-- 5) admin_law35_auto_scan(): غلاف للواجهة بصلاحية الإدمن (زر «تنفيذ المستحق الآن»).
-- 6) get_law_due_summary(): ملخص المستحق لبادج التنبيه التلقائي للإدمن.
-- 7) get_my_law_notifications / mark_my_law_notifications_read: واجهة الطالب.
-- 8) إعادة تعريف execute_attendance_law و admin_set_student_password لإضافة
--    الإشعار الفوري وتحويل طلب الاستعادة المعلّق إلى «معالَج» عند تسليم كلمة مرور.

-- ═══════════════════════════════════════════════════════════════
-- 1. جدول الإشعارات
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.attendance_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  subject_id UUID REFERENCES public.subjects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('warning1', 'warning2', 'deprivation')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  attendance_percent NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  UNIQUE (student_id, subject_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_attendance_notifications_student
  ON public.attendance_notifications(student_id, created_at DESC);

ALTER TABLE public.attendance_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS law_notifications_student_read ON public.attendance_notifications;
CREATE POLICY law_notifications_student_read ON public.attendance_notifications
  FOR SELECT USING (auth.uid() = student_id);

DROP POLICY IF EXISTS law_notifications_student_ack ON public.attendance_notifications;
CREATE POLICY law_notifications_student_ack ON public.attendance_notifications
  FOR UPDATE USING (auth.uid() = student_id) WITH CHECK (auth.uid() = student_id);

DROP POLICY IF EXISTS law_notifications_admin_all ON public.attendance_notifications;
CREATE POLICY law_notifications_admin_all ON public.attendance_notifications
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- لا سياسة إدراج للطالب: الإدراج يتم من دوال SECURITY DEFINER فقط.
GRANT SELECT, UPDATE ON public.attendance_notifications TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 2. نواة الحساب (قراءة فقط، للخدمة فقط)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.law35_scan_rows()
RETURNS TABLE (
  student_id UUID,
  student_name TEXT,
  national_id VARCHAR,
  student_level SMALLINT,
  subject_id UUID,
  subject_name TEXT,
  attended_sessions BIGINT,
  total_sessions BIGINT,
  attendance_percent NUMERIC,
  warning_count INTEGER,
  deduction_count INTEGER,
  is_banned BOOLEAN,
  last_action_at TIMESTAMPTZ,
  last_warning_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH sessions AS (
    SELECT ls.subject_id AS sid, COUNT(*)::BIGINT AS total
    FROM public.lecture_sessions ls
    WHERE ls.closed_at IS NOT NULL
    GROUP BY ls.subject_id
  ),
  attended AS (
    SELECT ls.subject_id AS sid, al.student_id AS student, COUNT(DISTINCT al.session_id)::BIGINT AS cnt
    FROM public.attendance_logs al
    JOIN public.lecture_sessions ls ON ls.id = al.session_id
    WHERE ls.closed_at IS NOT NULL
    GROUP BY ls.subject_id, al.student_id
  ),
  actions AS (
    SELECT
      a.student_id AS student,
      a.subject_id AS sub,
      COUNT(*) FILTER (WHERE a.action_type = 'warning')::INTEGER AS warn,
      COUNT(*) FILTER (WHERE a.action_type = 'deduction')::INTEGER AS ded,
      MAX(a.executed_at) AS last_at,
      MAX(a.executed_at) FILTER (WHERE a.action_type = 'warning') AS last_warn_at
    FROM public.attendance_law_actions a
    GROUP BY a.student_id, a.subject_id
  )
  SELECT
    st.id,
    st.full_name_ar,
    st.national_id,
    st.level,
    s.id,
    s.name_ar,
    COALESCE(att.cnt, 0),
    COALESCE(se.total, 0),
    CASE WHEN COALESCE(se.total, 0) = 0 THEN 100::NUMERIC
         ELSE ROUND(COALESCE(att.cnt, 0)::NUMERIC * 100 / se.total, 1) END,
    COALESCE(a.warn, 0),
    COALESCE(a.ded, 0),
    COALESCE(a.ded, 0) > 0,
    a.last_at,
    a.last_warn_at
  FROM public.student_subjects ss
  JOIN public.students st ON st.id = ss.student_id
  JOIN public.subjects s ON s.id = ss.subject_id
  LEFT JOIN sessions se ON se.sid = s.id
  LEFT JOIN attended att ON att.sid = s.id AND att.student = st.id
  LEFT JOIN actions a ON a.student = st.id AND a.sub = s.id
  WHERE ss.status IN ('active', 'parallel')
    AND st.status = 'approved'
    AND COALESCE(se.total, 0) > 0
    AND COALESCE(att.cnt, 0)::NUMERIC * 100 / se.total < 75
$$;

REVOKE ALL ON FUNCTION public.law35_scan_rows() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.law35_scan_rows() FROM anon;
REVOKE ALL ON FUNCTION public.law35_scan_rows() FROM authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 3. خطة المستحق الآن (للواجهة — الإدمن فقط)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.law35_due_plan(p_cooldown_days INTEGER DEFAULT 7)
RETURNS TABLE (
  student_id UUID,
  student_name TEXT,
  national_id VARCHAR,
  student_level SMALLINT,
  subject_id UUID,
  subject_name TEXT,
  attended_sessions BIGINT,
  total_sessions BIGINT,
  attendance_percent NUMERIC,
  warning_count INTEGER,
  deduction_count INTEGER,
  is_banned BOOLEAN,
  next_action TEXT,
  action_number INTEGER,
  due_now BOOLEAN,
  reason TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  RETURN QUERY
  SELECT
    r.student_id, r.student_name, r.national_id, r.student_level,
    r.subject_id, r.subject_name, r.attended_sessions, r.total_sessions, r.attendance_percent,
    r.warning_count, r.deduction_count, r.is_banned,
    CASE WHEN r.warning_count = 0 THEN 'warning1'
         WHEN r.warning_count < 2 THEN 'warning2'
         WHEN r.deduction_count = 0 THEN 'deprivation'
         ELSE 'none' END,
    r.warning_count + r.deduction_count + 1,
    CASE
      WHEN r.warning_count = 0 THEN TRUE
      WHEN r.warning_count < 2 THEN r.last_warning_at IS NULL OR r.last_warning_at <= now() - make_interval(days => GREATEST(p_cooldown_days, 0))
      WHEN r.deduction_count = 0 THEN r.last_action_at IS NULL OR r.last_action_at <= now() - make_interval(days => GREATEST(p_cooldown_days, 0))
      ELSE FALSE
    END,
    CASE
      WHEN r.warning_count = 0 THEN 'مستحق فورًا — إنذار أول'
      WHEN r.warning_count < 2 THEN CASE
        WHEN r.last_warning_at IS NULL OR r.last_warning_at <= now() - make_interval(days => GREATEST(p_cooldown_days, 0))
          THEN 'مستحق فورًا — إنذار ثانٍ'
        ELSE 'بانتظار انتهاء مهلة الإنذار الأول' END
      WHEN r.deduction_count = 0 THEN CASE
        WHEN r.last_action_at IS NULL OR r.last_action_at <= now() - make_interval(days => GREATEST(p_cooldown_days, 0))
          THEN 'مستحق فورًا — حرمان وفق المادة ٣٥'
        ELSE 'بانتظار انتهاء مهلة الإنذار الثاني' END
      ELSE 'نُفِّذ الإنذاران والحرمان' END
  FROM public.law35_scan_rows() r
  ORDER BY r.student_level, r.subject_name, r.student_name;
END;
$$;
GRANT EXECUTE ON FUNCTION public.law35_due_plan(INTEGER) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 4. تنفيذ المستحق فعليًا (الخدمة فقط — يستدعيه الفحص المجدول)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.law35_apply_plan(
  p_cooldown_days INTEGER DEFAULT 7,
  p_auto_ban BOOLEAN DEFAULT TRUE,
  p_dry_run BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  student_id UUID,
  student_name TEXT,
  subject_id UUID,
  subject_name TEXT,
  attendance_percent NUMERIC,
  action_type TEXT,
  action_number INTEGER,
  applied BOOLEAN,
  reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_action TEXT;
  v_notify BOOLEAN;
  v_body TEXT;
BEGIN
  FOR r IN
    SELECT * FROM public.law35_scan_rows() s
    WHERE (s.warning_count = 0)
       OR (s.warning_count < 2 AND (s.last_warning_at IS NULL OR s.last_warning_at <= now() - make_interval(days => GREATEST(p_cooldown_days, 0))))
       OR (s.warning_count >= 2 AND s.deduction_count = 0 AND (s.last_action_at IS NULL OR s.last_action_at <= now() - make_interval(days => GREATEST(p_cooldown_days, 0))))
    ORDER BY s.student_level, s.subject_name, s.student_name
  LOOP
    IF r.warning_count = 0 THEN
      v_action := 'warning'; v_notify := TRUE;
      v_body := 'نسبة حضورك في مادة ' || r.subject_name || ' هي ' || r.attendance_percent
             || '% وهي أقل من الحد الأدنى المطلوب (75%). هذا إنذار أول وفق المادة ٣٥: انتظامك في المحاضرات القادمة ضروري لتجنب الحرمان من دخول الامتحان النهائي.';
      IF NOT p_dry_run THEN
        INSERT INTO public.attendance_law_actions
          (student_id, subject_id, action_type, action_number, attendance_count, total_sessions, attendance_percent, executed_by)
        VALUES (r.student_id, r.subject_id, 'warning', 1, r.attended_sessions, r.total_sessions, r.attendance_percent, NULL)
        ON CONFLICT (student_id, subject_id, action_number) DO NOTHING;
      END IF;
      RETURN QUERY SELECT r.student_id, r.student_name, r.subject_id, r.subject_name, r.attendance_percent, 'warning'::TEXT, 1, NOT p_dry_run, 'إنذار أول';
    ELSIF r.warning_count < 2 THEN
      v_action := 'warning'; v_notify := TRUE;
      v_body := 'تكرر غيابك في مادة ' || r.subject_name || ' (نسبة الحضور ' || r.attendance_percent
             || '%). هذا إنذار ثانٍ وفق المادة ٣٥: استمرار الغياب يترتب عليه الحرمان من دخول الامتحان النهائي في هذه المادة.';
      IF NOT p_dry_run THEN
        INSERT INTO public.attendance_law_actions
          (student_id, subject_id, action_type, action_number, attendance_count, total_sessions, attendance_percent, executed_by)
        VALUES (r.student_id, r.subject_id, 'warning', 2, r.attended_sessions, r.total_sessions, r.attendance_percent, NULL)
        ON CONFLICT (student_id, subject_id, action_number) DO NOTHING;
      END IF;
      RETURN QUERY SELECT r.student_id, r.student_name, r.subject_id, r.subject_name, r.attendance_percent, 'warning'::TEXT, 2, NOT p_dry_run, 'إنذار ثانٍ';
    ELSE
      IF NOT p_auto_ban THEN CONTINUE; END IF;
      v_action := 'deduction'; v_notify := TRUE;
      v_body := 'لقد تجاوزت الحد المسموح به للغياب في مادة ' || r.subject_name || ' (نسبة الحضور ' || r.attendance_percent
             || '%). وفقًا للمادة ٣٥ تُحرم من دخول الامتحان النهائي في هذه المادة وتُعد راسبًا. يمكنك مراجعة إدارة القسم.';
      IF NOT p_dry_run THEN
        -- إجراء الحرمان فقط (بدون خصم درجات تلقائي) — الخصم قرار يدوي للإدمن.
        INSERT INTO public.attendance_law_actions
          (student_id, subject_id, action_type, action_number, attendance_count, total_sessions, attendance_percent, deducted_grade, executed_by)
        VALUES (r.student_id, r.subject_id, 'deduction', r.warning_count + 1, r.attended_sessions, r.total_sessions, r.attendance_percent, 0, NULL)
        ON CONFLICT (student_id, subject_id, action_number) DO NOTHING;
      END IF;
      RETURN QUERY SELECT r.student_id, r.student_name, r.subject_id, r.subject_name, r.attendance_percent, 'deprivation'::TEXT, r.warning_count + 1, NOT p_dry_run, 'حرمان (بدون خصم درجات تلقائي)';
    END IF;

    IF v_notify AND NOT p_dry_run THEN
      INSERT INTO public.attendance_notifications (student_id, subject_id, kind, title, body, attendance_percent)
      VALUES (
        r.student_id,
        r.subject_id,
        CASE WHEN v_action = 'deduction' THEN 'deprivation' WHEN r.warning_count = 0 THEN 'warning1' ELSE 'warning2' END,
        CASE WHEN v_action = 'deduction' THEN 'تنبيه حرمان — ' WHEN r.warning_count = 0 THEN 'إنذار أول — ' ELSE 'إنذار ثانٍ — ' END || r.subject_name,
        v_body,
        r.attendance_percent
      )
      ON CONFLICT (student_id, subject_id, kind) DO NOTHING;

      INSERT INTO public.audit_logs (action, entity_type, entity_id, actor_id, metadata)
      VALUES (
        'law35_auto_' || CASE WHEN v_action = 'deduction' THEN 'deprivation' WHEN r.warning_count = 0 THEN 'warning1' ELSE 'warning2' END,
        'students',
        r.student_id,
        NULL,
        jsonb_build_object('subject_id', r.subject_id, 'subject_name', r.subject_name,
                           'attendance_percent', r.attendance_percent,
                           'attended_sessions', r.attended_sessions, 'total_sessions', r.total_sessions,
                           'note', 'تنفيذ تلقائي مجدول للمادة ٣٥')
      );
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.law35_apply_plan(INTEGER, BOOLEAN, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.law35_apply_plan(INTEGER, BOOLEAN, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.law35_apply_plan(INTEGER, BOOLEAN, BOOLEAN) FROM authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 5. غلاف الواجهة: زر «تنفيذ المستحق الآن» (بصلاحية الإدمن)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.admin_law35_auto_scan(
  p_cooldown_days INTEGER DEFAULT 7,
  p_auto_ban BOOLEAN DEFAULT TRUE,
  p_dry_run BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  student_id UUID,
  student_name TEXT,
  subject_id UUID,
  subject_name TEXT,
  attendance_percent NUMERIC,
  action_type TEXT,
  action_number INTEGER,
  applied BOOLEAN,
  reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  RETURN QUERY SELECT * FROM public.law35_apply_plan(p_cooldown_days, p_auto_ban, p_dry_run);
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_law35_auto_scan(INTEGER, BOOLEAN, BOOLEAN) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 6. ملخص المستحق (بادج التنبيه التلقائي للإدمن)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_law_due_summary(p_cooldown_days INTEGER DEFAULT 7)
RETURNS TABLE (
  total_violators BIGINT,
  warnings_due BIGINT,
  deprivations_due BIGINT,
  due_now BIGINT,
  blocked BIGINT,
  banned_total BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT,
    COUNT(*) FILTER (WHERE d.next_action IN ('warning1', 'warning2'))::BIGINT,
    COUNT(*) FILTER (WHERE d.next_action = 'deprivation')::BIGINT,
    COUNT(*) FILTER (WHERE d.due_now)::BIGINT,
    COUNT(*) FILTER (WHERE NOT d.due_now)::BIGINT,
    COUNT(*) FILTER (WHERE d.is_banned)::BIGINT
  FROM public.law35_due_plan(p_cooldown_days) d;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_law_due_summary(INTEGER) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 7. واجهة الطالب: إشعاراته
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_my_law_notifications()
RETURNS TABLE (
  id UUID,
  subject_name TEXT,
  kind TEXT,
  title TEXT,
  body TEXT,
  attendance_percent NUMERIC,
  created_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_student UUID := auth.uid();
BEGIN
  IF v_student IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول أولًا'; END IF;
  RETURN QUERY
  SELECT n.id, COALESCE(s.name_ar, 'مادة دراسية'), n.kind, n.title, n.body, n.attendance_percent, n.created_at, n.read_at
  FROM public.attendance_notifications n
  LEFT JOIN public.subjects s ON s.id = n.subject_id
  WHERE n.student_id = v_student
  ORDER BY n.created_at DESC
  LIMIT 50;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_my_law_notifications() TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_my_law_notifications_read()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_student UUID := auth.uid(); v_count INTEGER;
BEGIN
  IF v_student IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول أولًا'; END IF;
  UPDATE public.attendance_notifications
     SET read_at = now()
   WHERE student_id = v_student AND read_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.mark_my_law_notifications_read() TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 8. إشعار فوري عند تنفيذ الإدمن اليدوي للقانون
-- ═══════════════════════════════════════════════════════════════
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
  v_new_grade NUMERIC; v_action TEXT; v_subject_name TEXT;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.student_subjects ss
                 WHERE ss.student_id = p_student_id AND ss.subject_id = p_subject_id
                   AND ss.status IN ('active', 'parallel')) THEN
    RAISE EXCEPTION 'الطالب غير مسجل في هذه المادة';
  END IF;

  SELECT s.name_ar INTO v_subject_name FROM public.subjects s WHERE s.id = p_subject_id;

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

    -- الإشعار الفوري للطالب (بنفس الثانية) — لا يتكرر بفضل القيد الفريد.
    INSERT INTO public.attendance_notifications (student_id, subject_id, kind, title, body, attendance_percent)
    VALUES (
      p_student_id, p_subject_id,
      CASE WHEN v_next = 1 THEN 'warning1' ELSE 'warning2' END,
      CASE WHEN v_next = 1 THEN 'إنذار أول — ' ELSE 'إنذار ثانٍ — ' END || COALESCE(v_subject_name, 'مادة دراسية'),
      CASE WHEN v_next = 1
        THEN 'نسبة حضورك في مادة ' || COALESCE(v_subject_name, '') || ' هي ' || v_percent
             || '% وهي أقل من الحد الأدنى المطلوب (75%). هذا إنذار أول وفق المادة ٣٥: انتظامك في المحاضرات القادمة ضروري لتجنب الحرمان من دخول الامتحان النهائي.'
        ELSE 'تكرر غيابك في مادة ' || COALESCE(v_subject_name, '') || ' (نسبة الحضور ' || v_percent
             || '%). هذا إنذار ثانٍ وفق المادة ٣٥: استمرار الغياب يترتب عليه الحرمان من دخول الامتحان النهائي في هذه المادة.' END,
      v_percent
    )
    ON CONFLICT (student_id, subject_id, kind) DO NOTHING;

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

  INSERT INTO public.attendance_notifications (student_id, subject_id, kind, title, body, attendance_percent)
  VALUES (
    p_student_id, p_subject_id, 'deprivation',
    'تنبيه حرمان — ' || COALESCE(v_subject_name, 'مادة دراسية'),
    'لقد تجاوزت الحد المسموح به للغياب في مادة ' || COALESCE(v_subject_name, '') || ' (نسبة الحضور ' || v_percent
    || '%). وفقًا للمادة ٣٥ تُحرم من دخول الامتحان النهائي في هذه المادة وتُعد راسبًا. يمكنك مراجعة إدارة القسم.',
    v_percent
  )
  ON CONFLICT (student_id, subject_id, kind) DO NOTHING;

  RETURN QUERY SELECT v_action, v_next, 1::NUMERIC, TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION public.execute_attendance_law(UUID, UUID) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 9. تعيين كلمة المرور: يُغلق طلب الاستعادة المعلّق كـ «معالَج»
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.admin_set_student_password(
  p_student_id UUID,
  p_new_password TEXT DEFAULT NULL
)
RETURNS TABLE (generated_password TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_password TEXT;
  v_email TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  SELECT email INTO v_email FROM public.students WHERE id = p_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الطالب غير موجود';
  END IF;

  IF p_new_password IS NOT NULL AND length(trim(p_new_password)) > 0 THEN
    v_password := trim(p_new_password);
  ELSE
    -- كلمة مرور مقروءة وقابلة للإملاء بالصوت: مقاطع + رقمان + رمز.
    -- أحرف واضحة فقط (بدون O/l/I/1/0/5/S/Z/2 الملبكة).
    v_password := (
      SELECT string_agg(seg, '')
      FROM (
        SELECT substring('bcdfghjklmnpqrstvwxz' FROM floor(random() * 20 + 1)::int FOR 1) AS seg
        UNION ALL SELECT substring('aeiou' FROM floor(random() * 5 + 1)::int FOR 1)
        UNION ALL SELECT substring('bcdfghjklmnpqrstvwxz' FROM floor(random() * 20 + 1)::int FOR 1)
        UNION ALL SELECT substring('aeiou' FROM floor(random() * 5 + 1)::int FOR 1)
        UNION ALL SELECT substring('34678' FROM floor(random() * 5 + 1)::int FOR 1)
        UNION ALL SELECT substring('34678' FROM floor(random() * 5 + 1)::int FOR 1)
        UNION ALL SELECT substring('@#&' FROM floor(random() * 3 + 1)::int FOR 1)
        UNION ALL SELECT substring('abcdefghjkmnpqrstuvwxyz' FROM floor(random() * 23 + 1)::int FOR 1)
      ) syllables
    );
  END IF;

  IF length(v_password) < 8 THEN
    RAISE EXCEPTION 'كلمة المرور غير مستوفية للشروط';
  END IF;
  IF NOT (v_password ~ '[a-z]' AND v_password ~ '[0-9]') THEN
    RAISE EXCEPTION 'كلمة المرور ضعيفة';
  END IF;

  UPDATE auth.users
     SET password = crypt(v_password, gen_salt('bf', 10)), updated_at = now()
   WHERE id = p_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'حساب المصادقة للطالب غير موجود';
  END IF;

  -- الكلمة الجديدة تجاوزت أي طلب معلّق: نغلقه كـ «معالَج» (سُلِّمت كلمة مرور).
  UPDATE public.password_reset_requests
     SET status = 'approved', new_password_set = true, handled_by = auth.uid(), handled_at = now()
   WHERE student_id = p_student_id AND status = 'pending';

  INSERT INTO public.audit_logs (action, entity_type, entity_id, actor_id, metadata)
  VALUES (
    'admin_set_student_password',
    'students',
    p_student_id,
    auth.uid(),
    jsonb_build_object('password_hash', crypt(v_password, gen_salt('bf', 4)), 'note',
      'الإدمن أعاد تعيين كلمة مرور الطالب. النص الصريح غير مخزَّن.')
  );

  RETURN QUERY SELECT v_password;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_student_password(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_set_student_password(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_student_password(UUID, TEXT) FROM anon;

-- ═══════════════════════════════════════════════════════════════
-- 10. التحقق من كلمة المرور الحالية (لخدمة تغيير كلمة المرور ذاتيًا)
-- دالة خدمة فقط (bcrpyt hash في auth.users — لا تُقرأ من المتصفح أبدًا).
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.verify_user_password(p_user_id UUID, p_password TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = p_user_id
      AND u.password IS NOT NULL
      AND u.password = crypt(p_password, u.password)
  );
$$;

REVOKE ALL ON FUNCTION public.verify_user_password(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_user_password(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.verify_user_password(UUID, TEXT) FROM authenticated;
