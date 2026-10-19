-- 025_law35_min_sessions.sql
-- ضمانة ضد الإنذارات المبكرة: لا يصدر المحرك التلقائي أي إجراء لمادة لم يُغلق فيها
-- عدد كافٍ من المحاضرات (افتراضيًا ٤). بدون ذلك، طالب غاب محاضرة واحدة من
-- محاضرتين (50%) كان يأخذ «إنذارًا أول» في بداية الترم — وهذا غير عادل.
-- العرض اليدوي في الواجهة يظل يرى كل المخالفين؛ الضمانة على *التنفيذ* فقط.
-- الإجراءات اليدوية (execute_attendance_law) لا تتأثر — الإدمن له القرار دائمًا.

DROP FUNCTION IF EXISTS public.law35_due_plan(INTEGER);
DROP FUNCTION IF EXISTS public.law35_apply_plan(INTEGER, BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS public.admin_law35_auto_scan(INTEGER, BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS public.get_law_due_summary(INTEGER);

-- ═══════════════════════════════════════════════════════════════
-- خطة المستحق (للواجهة — الإدمن فقط)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.law35_due_plan(
  p_cooldown_days INTEGER DEFAULT 7,
  p_min_sessions INTEGER DEFAULT 4
)
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
      WHEN r.total_sessions < GREATEST(p_min_sessions, 0) THEN FALSE
      WHEN r.warning_count = 0 THEN TRUE
      WHEN r.warning_count < 2 THEN r.last_warning_at IS NULL OR r.last_warning_at <= now() - make_interval(days => GREATEST(p_cooldown_days, 0))
      WHEN r.deduction_count = 0 THEN r.last_action_at IS NULL OR r.last_action_at <= now() - make_interval(days => GREATEST(p_cooldown_days, 0))
      ELSE FALSE
    END,
    CASE
      WHEN r.total_sessions < GREATEST(p_min_sessions, 0)
        THEN 'بانتظار اكتمال ' || GREATEST(p_min_sessions, 0) || ' محاضرات مغلقة (' || r.total_sessions || ' حتى الآن)'
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
GRANT EXECUTE ON FUNCTION public.law35_due_plan(INTEGER, INTEGER) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- تنفيذ المستحق (الخدمة فقط — يستدعيه الفحص المجدول)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.law35_apply_plan(
  p_cooldown_days INTEGER DEFAULT 7,
  p_auto_ban BOOLEAN DEFAULT TRUE,
  p_dry_run BOOLEAN DEFAULT FALSE,
  p_min_sessions INTEGER DEFAULT 4
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
  v_kind TEXT;
  v_title TEXT;
  v_body TEXT;
BEGIN
  FOR r IN
    SELECT * FROM public.law35_scan_rows() s
    WHERE s.total_sessions >= GREATEST(p_min_sessions, 0)
      AND (
        (s.warning_count = 0)
        OR (s.warning_count < 2 AND (s.last_warning_at IS NULL OR s.last_warning_at <= now() - make_interval(days => GREATEST(p_cooldown_days, 0))))
        OR (s.warning_count >= 2 AND s.deduction_count = 0 AND (s.last_action_at IS NULL OR s.last_action_at <= now() - make_interval(days => GREATEST(p_cooldown_days, 0))))
      )
    ORDER BY s.student_level, s.subject_name, s.student_name
  LOOP
    IF r.warning_count = 0 THEN
      v_action := 'warning'; v_kind := 'warning1'; v_title := 'إنذار أول — ' || r.subject_name;
      v_body := 'نسبة حضورك في مادة ' || r.subject_name || ' هي ' || r.attendance_percent
             || '% وهي أقل من الحد الأدنى المطلوب (75%). هذا إنذار أول وفق المادة ٣٥: انتظامك في المحاضرات القادمة ضروري لتجنب الحرمان من دخول الامتحان النهائي.';
      IF NOT p_dry_run THEN
        INSERT INTO public.attendance_law_actions
          (student_id, subject_id, action_type, action_number, attendance_count, total_sessions, attendance_percent, executed_by)
        VALUES (r.student_id, r.subject_id, 'warning', 1, r.attended_sessions, r.total_sessions, r.attendance_percent, NULL)
        ON CONFLICT (student_id, subject_id, action_number) DO NOTHING;
      END IF;
      RETURN QUERY SELECT r.student_id, r.student_name, r.subject_id, r.subject_name, r.attendance_percent, 'warning'::TEXT, 1, NOT p_dry_run, 'إنذار أول'::TEXT;
    ELSIF r.warning_count < 2 THEN
      v_action := 'warning'; v_kind := 'warning2'; v_title := 'إنذار ثانٍ — ' || r.subject_name;
      v_body := 'تكرر غيابك في مادة ' || r.subject_name || ' (نسبة الحضور ' || r.attendance_percent
             || '%). هذا إنذار ثانٍ وفق المادة ٣٥: استمرار الغياب يترتب عليه الحرمان من دخول الامتحان النهائي في هذه المادة.';
      IF NOT p_dry_run THEN
        INSERT INTO public.attendance_law_actions
          (student_id, subject_id, action_type, action_number, attendance_count, total_sessions, attendance_percent, executed_by)
        VALUES (r.student_id, r.subject_id, 'warning', 2, r.attended_sessions, r.total_sessions, r.attendance_percent, NULL)
        ON CONFLICT (student_id, subject_id, action_number) DO NOTHING;
      END IF;
      RETURN QUERY SELECT r.student_id, r.student_name, r.subject_id, r.subject_name, r.attendance_percent, 'warning'::TEXT, 2, NOT p_dry_run, 'إنذار ثانٍ'::TEXT;
    ELSE
      IF NOT p_auto_ban THEN CONTINUE; END IF;
      v_action := 'deduction'; v_kind := 'deprivation'; v_title := 'تنبيه حرمان — ' || r.subject_name;
      v_body := 'لقد تجاوزت الحد المسموح به للغياب في مادة ' || r.subject_name || ' (نسبة الحضور ' || r.attendance_percent
             || '%). وفقًا للمادة ٣٥ تُحرم من دخول الامتحان النهائي في هذه المادة وتُعد راسبًا. يمكنك مراجعة إدارة القسم.';
      IF NOT p_dry_run THEN
        -- إجراء الحرمان فقط (بدون خصم درجات تلقائي) — الخصم قرار يدوي للإدمن.
        INSERT INTO public.attendance_law_actions
          (student_id, subject_id, action_type, action_number, attendance_count, total_sessions, attendance_percent, deducted_grade, executed_by)
        VALUES (r.student_id, r.subject_id, 'deduction', r.warning_count + 1, r.attended_sessions, r.total_sessions, r.attendance_percent, 0, NULL)
        ON CONFLICT (student_id, subject_id, action_number) DO NOTHING;
      END IF;
      RETURN QUERY SELECT r.student_id, r.student_name, r.subject_id, r.subject_name, r.attendance_percent, 'deprivation'::TEXT, r.warning_count + 1, NOT p_dry_run, 'حرمان (بدون خصم درجات تلقائي)'::TEXT;
    END IF;

    IF NOT p_dry_run THEN
      INSERT INTO public.attendance_notifications (student_id, subject_id, kind, title, body, attendance_percent)
      VALUES (r.student_id, r.subject_id, v_kind, v_title, v_body, r.attendance_percent)
      ON CONFLICT (student_id, subject_id, kind) DO NOTHING;

      INSERT INTO public.audit_logs (action, entity_type, entity_id, actor_id, metadata)
      VALUES (
        'law35_auto_' || v_kind,
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

REVOKE ALL ON FUNCTION public.law35_apply_plan(INTEGER, BOOLEAN, BOOLEAN, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.law35_apply_plan(INTEGER, BOOLEAN, BOOLEAN, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.law35_apply_plan(INTEGER, BOOLEAN, BOOLEAN, INTEGER) FROM authenticated;

-- ═══════════════════════════════════════════════════════════════
-- غلاف الواجهة (بصلاحية الإدمن)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.admin_law35_auto_scan(
  p_cooldown_days INTEGER DEFAULT 7,
  p_auto_ban BOOLEAN DEFAULT TRUE,
  p_dry_run BOOLEAN DEFAULT FALSE,
  p_min_sessions INTEGER DEFAULT 4
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
  RETURN QUERY SELECT * FROM public.law35_apply_plan(p_cooldown_days, p_auto_ban, p_dry_run, p_min_sessions);
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_law35_auto_scan(INTEGER, BOOLEAN, BOOLEAN, INTEGER) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- ملخص المستحق (بادج التنبيه التلقائي للإدمن)
-- ═══════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_law_due_summary(
  p_cooldown_days INTEGER DEFAULT 7,
  p_min_sessions INTEGER DEFAULT 4
)
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
  FROM public.law35_due_plan(p_cooldown_days, p_min_sessions) d;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_law_due_summary(INTEGER, INTEGER) TO authenticated;
