-- ══════════════════════════════════════════════════════════════════════
-- 033_admin_scoped_control.sql
-- تقنين صلاحيات «أدمن المادة» بصرامة (منع أي تلاعب أو تخريب بالنظام)،
-- مع إبقاء المشرف العام (مدير النظام) صاحب كل الصلاحيات كما هو.
--
-- ما تنص عليه هذه الهجرة:
--   1) جدول admin_permissions: المشرف العام وحده يمنح أدمن المادة «طلبات
--      تسجيل الطلاب». بدون المنحة لا تظهر الشاشة ولا يعمل الاعتماد/الرفض.
--   2) نطاق الأدمن = موادّه المسندة فقط، ومستوياتها فقط (تُشتق تلقائيًا من
--      المواد). كل فلتر في الواجهة يُثبَّت على هذا النطاق في قاعدة البيانات.
--   3) قيود RLS صارمة: الطلاب، الأرقام المسموح لها بالتسجيل، الجلسات،
--      سجلات الحضور، طلبات إعادة تعيين المرور، النطاق الجغرافي.
--   4) تقييد الدوال التي كانت تسمح لأي إدمن بالعمل على النظام كله
--      (المادة ٣٥ التلقائية، طلبات إضافة المواد، حذف الطالب نهائيًا…).
--   5) اسم الأدمن عربي/إنجليزي + تغيير كلمة مروره بنفسه بلا حدود.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) صلاحيات أدمن المادة (يمنحها المشرف العام فقط) ──
CREATE TABLE IF NOT EXISTS public.admin_permissions (
  admin_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  can_review_registrations BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

ALTER TABLE public.admin_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_permissions_read ON public.admin_permissions;
CREATE POLICY admin_permissions_read ON public.admin_permissions
  FOR SELECT USING (auth.uid() = admin_id OR public.is_super_admin());
DROP POLICY IF EXISTS admin_permissions_super_write ON public.admin_permissions;
CREATE POLICY admin_permissions_super_write ON public.admin_permissions
  FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ── 2) نطاق الأدمن: المواد والمستويات ──

-- مواد الأدمن الحالي. NULL = كل المواد (المشرف العام أو نداء الخدمة).
CREATE OR REPLACE FUNCTION public.admin_subject_scope(p_admin_id UUID DEFAULT auth.uid())
RETURNS UUID[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p_admin_id IS NULL THEN NULL
    WHEN public.is_super_admin(p_admin_id) THEN NULL
    ELSE COALESCE(
      (SELECT array_agg(sa.subject_id) FROM public.subject_admins sa WHERE sa.admin_id = p_admin_id),
      ARRAY[]::UUID[])
  END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_subject_scope(UUID) TO authenticated, anon;

-- مستويات الأدمن الحالي (المشتقة من مواده). NULL = كل المستويات.
CREATE OR REPLACE FUNCTION public.my_admin_levels(p_admin_id UUID DEFAULT auth.uid())
RETURNS SMALLINT[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p_admin_id IS NULL THEN NULL
    WHEN public.is_super_admin(p_admin_id) THEN NULL
    ELSE COALESCE(
      (SELECT array_agg(DISTINCT s.level ORDER BY s.level)
         FROM public.subject_admins sa
         JOIN public.subjects s ON s.id = sa.subject_id
        WHERE sa.admin_id = p_admin_id),
      ARRAY[]::SMALLINT[])
  END;
$$;
GRANT EXECUTE ON FUNCTION public.my_admin_levels(UUID) TO authenticated;

-- هل يملك الأدمن صلاحية «طلبات تسجيل الطلاب»؟ (المشرف العام دائمًا نعم)
CREATE OR REPLACE FUNCTION public.admin_can_review_registrations(p_admin_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p_admin_id IS NULL THEN TRUE
    WHEN public.is_super_admin(p_admin_id) THEN TRUE
    ELSE COALESCE(
      (SELECT ap.can_review_registrations FROM public.admin_permissions ap WHERE ap.admin_id = p_admin_id),
      FALSE)
  END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_can_review_registrations(UUID) TO authenticated;

-- هل الطالب داخل نطاق الأدمن (مسجّل في إحدى مواده)؟
CREATE OR REPLACE FUNCTION public.admin_can_see_student(p_student_id UUID, p_admin_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p_student_id IS NULL THEN FALSE
    WHEN p_admin_id IS NULL THEN TRUE
    WHEN public.is_super_admin(p_admin_id) THEN TRUE
    ELSE EXISTS (
      SELECT 1
        FROM public.student_subjects ss
       WHERE ss.student_id = p_student_id
         AND ss.subject_id = ANY(COALESCE(public.admin_subject_scope(p_admin_id), ARRAY[]::UUID[]))
    )
  END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_can_see_student(UUID, UUID) TO authenticated;

-- ملخص نطاق الأدمن الحالي — تبني عليه الواجهة لوحتها وفلاترها المثبتة.
DROP FUNCTION IF EXISTS public.my_admin_scope();
CREATE OR REPLACE FUNCTION public.my_admin_scope()
RETURNS TABLE (
  admin_id UUID,
  full_name TEXT,
  full_name_ar TEXT,
  full_name_en TEXT,
  is_super BOOLEAN,
  subject_ids UUID[],
  subject_names TEXT[],
  levels SMALLINT[],
  can_review_registrations BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  RETURN QUERY
  SELECT
    a.id,
    a.full_name,
    COALESCE(a.full_name_ar, a.full_name),
    COALESCE(a.full_name_en, a.full_name),
    public.is_super_admin(a.id),
    COALESCE(public.admin_subject_scope(a.id), ARRAY[]::UUID[]),
    COALESCE((
      SELECT array_agg(s.name_ar ORDER BY s.level, s.name_ar)
        FROM public.subject_admins sa
        JOIN public.subjects s ON s.id = sa.subject_id
       WHERE sa.admin_id = a.id AND sa.role = 'subject'
    ), ARRAY[]::TEXT[]),
    COALESCE(public.my_admin_levels(a.id), ARRAY[]::SMALLINT[]),
    public.admin_can_review_registrations(a.id)
  FROM public.admins a
  WHERE a.id = auth.uid();
END;
$$;
GRANT EXECUTE ON FUNCTION public.my_admin_scope() TO authenticated;

-- ── 3) منح/سحب صلاحية «طلبات تسجيل الطلاب» — المشرف العام فقط ──
CREATE OR REPLACE FUNCTION public.super_set_admin_permissions(
  p_admin_id UUID,
  p_can_review_registrations BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'غير مصرح — المشرف العام فقط'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_admin_id) THEN
    RAISE EXCEPTION 'الحساب غير موجود';
  END IF;

  INSERT INTO public.admin_permissions (admin_id, can_review_registrations, updated_at, updated_by)
  VALUES (p_admin_id, COALESCE(p_can_review_registrations, FALSE), now(), auth.uid())
  ON CONFLICT (admin_id) DO UPDATE
    SET can_review_registrations = EXCLUDED.can_review_registrations,
        updated_at = now(),
        updated_by = auth.uid();

  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), 'super_set_admin_permissions', 'admins', p_admin_id,
    jsonb_build_object('can_review_registrations', COALESCE(p_can_review_registrations, FALSE)));
END;
$$;
REVOKE ALL ON FUNCTION public.super_set_admin_permissions(UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.super_set_admin_permissions(UUID, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.super_set_admin_permissions(UUID, BOOLEAN) TO authenticated;

-- ── 4) اسم الأدمن (عربي/إنجليزي) + كلمة مروره بنفسه بلا حدود ──
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS full_name_ar TEXT;
ALTER TABLE public.admins ADD COLUMN IF NOT EXISTS full_name_en TEXT;
UPDATE public.admins
   SET full_name_ar = COALESCE(full_name_ar, full_name),
       full_name_en = COALESCE(full_name_en, full_name)
 WHERE full_name_ar IS NULL OR full_name_en IS NULL;

CREATE OR REPLACE FUNCTION public.admin_update_own_profile(
  p_full_name_ar TEXT,
  p_full_name_en TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ar TEXT := btrim(regexp_replace(COALESCE(p_full_name_ar, ''), '\s+', ' ', 'g'));
  v_en TEXT := btrim(regexp_replace(COALESCE(p_full_name_en, ''), '\s+', ' ', 'g'));
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'غير مصرح — هذه العملية للأدمن فقط');
  END IF;
  IF v_ar = '' OR v_en = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'الاسم بالعربية والإنجليزية مطلوبان معًا');
  END IF;
  IF v_ar ~ '[A-Za-z0-9]' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'الاسم بالعربية يجب أن يكون بحروف عربية فقط');
  END IF;
  IF v_en !~ '^[A-Za-z][A-Za-z\s]*$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'الاسم بالإنجليزية يجب أن يكون بحروف إنجليزية فقط');
  END IF;
  IF array_length(regexp_split_to_array(v_ar, '\s+'), 1) < 2
     OR array_length(regexp_split_to_array(v_en, '\s+'), 1) < 2 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'أدخل الاسم كاملًا بالعربية والإنجليزية');
  END IF;

  UPDATE public.admins
     SET full_name = v_ar, full_name_ar = v_ar, full_name_en = v_en
   WHERE id = auth.uid();

  INSERT INTO public.audit_logs (action, entity_type, entity_id, actor_id, metadata)
  VALUES ('admin_update_own_profile', 'admins', auth.uid(), auth.uid(),
    jsonb_build_object('full_name_ar', v_ar, 'full_name_en', v_en));

  RETURN jsonb_build_object('ok', TRUE, 'full_name_ar', v_ar, 'full_name_en', v_en, 'full_name', v_ar);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_update_own_profile(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_update_own_profile(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_update_own_profile(TEXT, TEXT) TO authenticated;

-- تغيير كلمة مرور الأدمن بنفسه — يشترط الكلمة الحالية، وعدد المرات غير محدود
-- (بخلاف الطالب المحدد بـ3 مرات في الترم).
CREATE OR REPLACE FUNCTION public.admin_change_own_password(
  p_current_password TEXT,
  p_new_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_hash TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'غير مصرح — هذه العملية للأدمن فقط');
  END IF;
  IF p_new_password IS NULL OR length(p_new_password) < 8
     OR NOT (p_new_password ~ '[a-z]' AND p_new_password ~ '[A-Z]' AND p_new_password ~ '[0-9]' AND p_new_password ~ '[^A-Za-z0-9]') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'كلمة المرور يجب أن تشمل حرفًا كبيرًا وصغيرًا ورقمًا ورمزًا و8 أحرف على الأقل');
  END IF;
  IF p_current_password IS NULL OR btrim(p_current_password) = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'أدخل كلمة المرور الحالية');
  END IF;
  IF p_current_password = p_new_password THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'كلمة المرور الجديدة مطابقة للحالية');
  END IF;

  SELECT u.password INTO v_hash FROM auth.users u WHERE u.id = auth.uid();
  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'حساب الدخول غير موجود');
  END IF;
  IF crypt(p_current_password, v_hash) <> v_hash THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'كلمة المرور الحالية غير صحيحة');
  END IF;

  UPDATE auth.users
     SET password = crypt(p_new_password, gen_salt('bf', 10)), updated_at = now()
   WHERE id = auth.uid();

  PERFORM public.revoke_user_sessions(auth.uid());

  INSERT INTO public.audit_logs (action, entity_type, entity_id, actor_id, metadata)
  VALUES ('admin_change_own_password', 'admins', auth.uid(), auth.uid(),
    jsonb_build_object('note', 'الأدمن غيّر كلمة مروره بنفسه. النص الصريح غير مخزَّن.'));

  RETURN jsonb_build_object('ok', TRUE);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_change_own_password(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_change_own_password(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_change_own_password(TEXT, TEXT) TO authenticated;

-- ── 5) قائمة حسابات الأدمن: تعرض المستويات والصلاحية الممنوحة ──
DROP FUNCTION IF EXISTS public.list_subject_admins();
CREATE OR REPLACE FUNCTION public.list_subject_admins()
RETURNS TABLE (
  admin_id UUID,
  full_name TEXT,
  email TEXT,
  subject_ids UUID[],
  levels SMALLINT[],
  can_review_registrations BOOLEAN,
  is_super BOOLEAN,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'غير مصرح — المشرف العام فقط'; END IF;
  RETURN QUERY
  SELECT a.id, a.full_name, a.email,
    COALESCE(public.admin_subject_scope(a.id), ARRAY[]::UUID[]),
    COALESCE(public.my_admin_levels(a.id), ARRAY[]::SMALLINT[]),
    public.admin_can_review_registrations(a.id),
    public.is_super_admin(a.id),
    a.created_at
  FROM public.admins a
  ORDER BY a.created_at;
END;
$$;
GRANT EXECUTE ON FUNCTION public.list_subject_admins() TO authenticated;

-- حذف حساب أدمن مادة: يمسح صلاحياته الممنوحة أيضًا.
CREATE OR REPLACE FUNCTION public.super_delete_subject_admin(p_admin_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'غير مصرح — المشرف العام فقط'; END IF;
  IF public.is_super_admin(p_admin_id) THEN
    RAISE EXCEPTION 'لا يمكن حذف المشرف العام';
  END IF;
  DELETE FROM public.admin_permissions WHERE admin_id = p_admin_id;
  DELETE FROM public.subject_admins WHERE admin_id = p_admin_id;
  DELETE FROM public.admins WHERE id = p_admin_id;
  DELETE FROM auth.users WHERE id = p_admin_id;
END;
$$;
REVOKE ALL ON FUNCTION public.super_delete_subject_admin(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.super_delete_subject_admin(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.super_delete_subject_admin(UUID) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- 6) قيود RLS: أدمن المادة لا يرى ولا يلمس خارج نطاقه
-- ══════════════════════════════════════════════════════════════════════

-- الطلاب: لا يرى إلا طلاب مواده. الاعتماد/الرفض يحتاج منحة المشرف العام.
DROP POLICY IF EXISTS students_self_or_admin_select ON public.students;
CREATE POLICY students_self_or_admin_select ON public.students
  FOR SELECT USING (
    auth.uid() = id
    OR public.is_super_admin()
    OR (public.is_admin() AND public.admin_can_see_student(id, auth.uid()))
  );

DROP POLICY IF EXISTS students_self_or_admin_update ON public.students;
CREATE POLICY students_self_or_admin_update ON public.students
  FOR UPDATE USING (
    auth.uid() = id
    OR public.is_super_admin()
    OR (public.is_admin() AND public.admin_can_review_registrations(auth.uid()) AND public.admin_can_see_student(id, auth.uid()))
  ) WITH CHECK (
    auth.uid() = id
    OR public.is_super_admin()
    OR (public.is_admin() AND public.admin_can_review_registrations(auth.uid()) AND public.admin_can_see_student(id, auth.uid()))
  );

-- الأرقام المسموح لها بالتسجيل: الأدمن يرى مستوى/مستوياته فقط، والكتابة للمشرف العام.
DROP POLICY IF EXISTS national_ids_admin_only ON public.national_ids;
DROP POLICY IF EXISTS national_ids_scoped_read ON public.national_ids;
CREATE POLICY national_ids_scoped_read ON public.national_ids
  FOR SELECT USING (
    public.is_admin()
    AND (public.is_super_admin() OR level = ANY(COALESCE(public.my_admin_levels(), ARRAY[]::SMALLINT[])))
  );
DROP POLICY IF EXISTS national_ids_super_write ON public.national_ids;
CREATE POLICY national_ids_super_write ON public.national_ids
  FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- الجلسات: الأدمن يقرأ جلسات مواده فقط (الطالب يرى الجلسات النشطة كما كان).
DROP POLICY IF EXISTS sessions_student_read_admin_all ON public.lecture_sessions;
CREATE POLICY sessions_student_read_admin_all ON public.lecture_sessions
  FOR SELECT USING (
    public.is_super_admin()
    OR (public.is_admin() AND EXISTS (
      SELECT 1 FROM public.subject_admins sa
       WHERE sa.admin_id = auth.uid() AND sa.subject_id = subject_id))
    OR (is_active AND EXISTS (SELECT 1 FROM public.students st WHERE st.id = auth.uid() AND st.status = 'approved'))
  );

-- سجلات الحضور: الإدراج اليدوي مقصور على جلسات موادّه.
DROP POLICY IF EXISTS admin_insert_attendance ON public.attendance_logs;
CREATE POLICY admin_insert_attendance ON public.attendance_logs
  FOR INSERT WITH CHECK (
    public.is_super_admin()
    OR (public.is_admin() AND EXISTS (
      SELECT 1 FROM public.lecture_sessions ls
       WHERE ls.id = session_id AND public.is_subject_admin_for(auth.uid(), ls.subject_id)))
  );

-- تسجيلات المواد: الأدمن يقرأ/يعدّل تسجيلات مواده فقط.
DROP POLICY IF EXISTS student_subjects_self_or_admin ON public.student_subjects;
CREATE POLICY student_subjects_self_or_admin ON public.student_subjects
  FOR SELECT USING (
    auth.uid() = student_id
    OR public.is_super_admin()
    OR (public.is_admin() AND (public.admin_subject_scope() IS NULL OR subject_id = ANY(public.admin_subject_scope())))
  );
DROP POLICY IF EXISTS admin_manage_enrollments ON public.student_subjects;
CREATE POLICY admin_manage_enrollments ON public.student_subjects
  FOR ALL USING (
    public.is_super_admin()
    OR (public.is_admin() AND (public.admin_subject_scope() IS NULL OR subject_id = ANY(public.admin_subject_scope())))
  ) WITH CHECK (
    public.is_super_admin()
    OR (public.is_admin() AND (public.admin_subject_scope() IS NULL OR subject_id = ANY(public.admin_subject_scope())))
  );

-- طلبات إعادة تعيين المرور: للمشرف العام فقط (الطالب يرى طلبه هو كما كان).
DROP POLICY IF EXISTS admin_manage_reset_requests ON public.password_reset_requests;
CREATE POLICY admin_manage_reset_requests ON public.password_reset_requests
  FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- النطاق الجغرافي: تغييره للمشرف العام فقط (كان متاحًا لكل إدمن).
DROP POLICY IF EXISTS geofence_admin_only ON public.geofence_config;
CREATE POLICY geofence_admin_only ON public.geofence_config
  FOR ALL USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- إجراءات المادة ٣٥: الأدمن يرى إجراءات موادّه فقط؛ التنفيذ عبر الدوال المقيّدة.
DROP POLICY IF EXISTS law_actions_admin_all ON public.attendance_law_actions;
CREATE POLICY law_actions_admin_all ON public.attendance_law_actions
  FOR ALL USING (
    public.is_super_admin()
    OR (public.is_admin() AND (public.admin_subject_scope() IS NULL OR subject_id = ANY(public.admin_subject_scope())))
  ) WITH CHECK (
    public.is_super_admin()
    OR (public.is_admin() AND (public.admin_subject_scope() IS NULL OR subject_id = ANY(public.admin_subject_scope())))
  );

-- ══════════════════════════════════════════════════════════════════════
-- 7) تقييد الدوال التي كانت تعمل على النظام كله
-- ══════════════════════════════════════════════════════════════════════

-- تقرير الالتزام: لا مستوى خارج نطاق الأدمن، ولا مواد غير مواده.
CREATE OR REPLACE FUNCTION public.get_attendance_compliance(p_level SMALLINT DEFAULT NULL, p_subject_id UUID DEFAULT NULL)
RETURNS TABLE (
  student_id UUID, student_name TEXT, national_id VARCHAR, student_status TEXT,
  level SMALLINT, subject_id UUID, subject_name TEXT,
  attended_sessions BIGINT, total_sessions BIGINT, attendance_percent NUMERIC,
  below_minimum BOOLEAN, warning_count INTEGER, deduction_count INTEGER,
  is_banned BOOLEAN, max_grade SMALLINT, current_year_work NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_ids UUID[];
  v_levels SMALLINT[];
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  v_ids := public.admin_subject_scope();
  v_levels := public.my_admin_levels();
  IF v_levels IS NOT NULL AND p_level IS NOT NULL AND NOT (p_level = ANY(v_levels)) THEN
    RAISE EXCEPTION 'غير مصرح — هذه الفرقة خارج نطاقك';
  END IF;
  RETURN QUERY
  WITH counts AS (
    SELECT ls.subject_id AS sid,
      COUNT(*)::BIGINT AS total,
      COUNT(DISTINCT al.session_id)::BIGINT AS attended
    FROM public.lecture_sessions ls
    LEFT JOIN public.attendance_logs al ON al.session_id = ls.id
    WHERE ls.closed_at IS NOT NULL
    GROUP BY ls.subject_id
  ),
  actions AS (
    SELECT a.student_id AS ast, a.subject_id AS asub,
      COUNT(*) FILTER (WHERE a.action_type = 'warning')::INTEGER AS warn,
      COUNT(*) FILTER (WHERE a.action_type = 'deduction')::INTEGER AS ded
    FROM public.attendance_law_actions a
    GROUP BY a.student_id, a.subject_id
  )
  SELECT st.id, st.full_name_ar, st.national_id, st.status::TEXT, st.level,
    s.id, s.name_ar,
    COALESCE(c.attended, 0), COALESCE(c.total, 0),
    CASE WHEN COALESCE(c.total, 0) = 0 THEN 100::NUMERIC
         ELSE ROUND(COALESCE(c.attended, 0)::NUMERIC * 100 / c.total, 1) END,
    COALESCE(c.total, 0) > 0 AND COALESCE(c.attended, 0)::NUMERIC * 100 / c.total < 75,
    COALESCE(a.warn, 0), COALESCE(a.ded, 0), COALESCE(a.ded, 0) > 0,
    s.max_grade, ss.year_work_grade
  FROM public.student_subjects ss
  JOIN public.students st ON st.id = ss.student_id
  JOIN public.subjects s ON s.id = ss.subject_id
  LEFT JOIN counts c ON c.sid = s.id
  LEFT JOIN actions a ON a.ast = st.id AND a.asub = s.id
  WHERE ss.status IN ('active', 'parallel')
    AND (p_level IS NULL OR st.level = p_level)
    AND (p_subject_id IS NULL OR s.id = p_subject_id)
    AND (v_ids IS NULL OR s.id = ANY(v_ids))
    AND (v_levels IS NULL OR st.level = ANY(v_levels))
  ORDER BY st.level, s.name_ar, st.full_name_ar;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_attendance_compliance(SMALLINT, UUID) TO authenticated;

-- المادة ٣٥ التلقائية: كانت تنفّذ القانون على النظام كله لأي إدمن.
-- الآن: أدمن المادة ينفّذ في مواده فقط، والمشرف العام/الجدولة على الكل.
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
  v_subjects UUID[];
BEGIN
  v_subjects := public.admin_subject_scope();
  FOR r IN
    SELECT * FROM public.law35_scan_rows() s
    WHERE s.total_sessions >= GREATEST(p_min_sessions, 0)
      AND (v_subjects IS NULL OR s.subject_id = ANY(v_subjects))
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
        auth.uid(),
        jsonb_build_object('subject_id', r.subject_id, 'subject_name', r.subject_name,
                           'attendance_percent', r.attendance_percent,
                           'attended_sessions', r.attended_sessions, 'total_sessions', r.total_sessions,
                           'note', CASE WHEN auth.uid() IS NULL
                                        THEN 'تنفيذ تلقائي مجدول للمادة ٣٥'
                                        ELSE 'تنفيذ للمادة ٣٥ من لوحة أدمن المادة' END)
      );
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.law35_apply_plan(INTEGER, BOOLEAN, BOOLEAN, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.law35_apply_plan(INTEGER, BOOLEAN, BOOLEAN, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.law35_apply_plan(INTEGER, BOOLEAN, BOOLEAN, INTEGER) FROM authenticated;

-- خطة المستحق: مرئية للأدمن داخل مواده فقط.
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
DECLARE
  v_subjects UUID[];
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  v_subjects := public.admin_subject_scope();
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
  WHERE (v_subjects IS NULL OR r.subject_id = ANY(v_subjects))
  ORDER BY r.student_level, r.subject_name, r.student_name;
END;
$$;
GRANT EXECUTE ON FUNCTION public.law35_due_plan(INTEGER, INTEGER) TO authenticated;

-- طلبات إضافة المواد: المشرف العام فقط (لا تظهر ولا تُنفَّذ لأي أدمن مادة).
CREATE OR REPLACE FUNCTION public.pending_add_subject_requests()
RETURNS TABLE (
  request_id UUID,
  student_id UUID,
  student_name TEXT,
  national_id VARCHAR,
  student_email TEXT,
  level SMALLINT,
  subject_id UUID,
  subject_name TEXT,
  term public.academic_term,
  requested_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'غير مصرح — المشرف العام فقط'; END IF;
  RETURN QUERY
  SELECT
    r.id,
    r.student_id,
    st.full_name_ar,
    st.national_id,
    st.email,
    r.level,
    r.subject_id,
    s.name_ar,
    r.term,
    r.requested_at
  FROM public.student_add_subject_requests r
  JOIN public.students st ON st.id = r.student_id
  JOIN public.subjects s ON s.id = r.subject_id
  WHERE r.status = 'pending'
  ORDER BY r.requested_at;
END;
$$;
GRANT EXECUTE ON FUNCTION public.pending_add_subject_requests() TO authenticated;

-- حذف/اعتماد طالب نهائيًا (purge): المشرف العام فقط.
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
  IF NOT public.is_super_admin(p_admin_id) THEN
    RAISE EXCEPTION 'غير مصرح — حذف حساب طالب نهائيًا للمشرف العام فقط';
  END IF;

  SELECT national_id INTO v_national_id
  FROM public.students
  WHERE id = p_student_id;

  IF v_national_id IS NOT NULL THEN
    UPDATE public.national_ids
       SET is_claimed = false, claimed_by = NULL
     WHERE claimed_by = p_student_id OR national_id = v_national_id;
  END IF;

  DELETE FROM public.audit_logs WHERE actor_id = p_student_id;
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

-- إعادة تعيين كلمة مرور الطالب من لوحة الأدمن: داخل نطاقه فقط.
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
  IF NOT public.is_super_admin() AND NOT public.admin_can_see_student(p_student_id) THEN
    RAISE EXCEPTION 'غير مصرح — هذا الطالب خارج نطاق موادك';
  END IF;

  SELECT email INTO v_email FROM public.students WHERE id = p_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الطالب غير موجود';
  END IF;

  IF p_new_password IS NOT NULL AND length(trim(p_new_password)) > 0 THEN
    v_password := trim(p_new_password);
  ELSE
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

  UPDATE auth.users
     SET password = crypt(v_password, gen_salt('bf', 10)), updated_at = now()
   WHERE id = p_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'حساب المصادقة للطالب غير موجود';
  END IF;

  PERFORM public.revoke_user_sessions(p_student_id);

  UPDATE public.password_reset_requests
     SET status = 'rejected', handled_at = now()
   WHERE student_id = p_student_id AND status = 'pending';

  INSERT INTO public.audit_logs (action, entity_type, entity_id, actor_id, metadata)
  VALUES (
    'admin_set_student_password',
    'students',
    p_student_id,
    auth.uid(),
    jsonb_build_object('note', 'إعادة تعيين كلمة مرور الطالب. النص الصريح غير مخزَّن. وأُبطلت جميع الجلسات النشطة.')
  );

  RETURN QUERY SELECT v_password;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_student_password(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_set_student_password(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_student_password(UUID, TEXT) FROM anon;

-- اعتماد طلبات إضافة المواد: المشرف العام فقط.
CREATE OR REPLACE FUNCTION public.handle_add_subject_requests(
  p_request_ids UUID[],
  p_approve BOOLEAN
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth AS $$
DECLARE
  r RECORD;
  v_count INTEGER := 0;
BEGIN
  IF p_request_ids IS NULL THEN RETURN 0; END IF;
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'غير مصرح — المشرف العام فقط'; END IF;

  FOR r IN
    SELECT * FROM public.student_add_subject_requests
    WHERE id = ANY(p_request_ids) AND status = 'pending'
  LOOP
    IF p_approve THEN
      -- نفس آلية التسجيل الأول بالضبط: صف enrollment نشط.
      IF EXISTS (
        SELECT 1 FROM public.student_subjects ss
        WHERE ss.student_id = r.student_id AND ss.subject_id = r.subject_id
          AND ss.status IN ('active', 'parallel')
      ) THEN
        NULL;
      ELSIF EXISTS (
        SELECT 1 FROM public.student_subjects ss
        WHERE ss.student_id = r.student_id AND ss.subject_id = r.subject_id
      ) THEN
        UPDATE public.student_subjects ss
           SET status = 'active'
         WHERE ss.student_id = r.student_id AND ss.subject_id = r.subject_id;
      ELSE
        INSERT INTO public.student_subjects (student_id, subject_id, status)
        VALUES (r.student_id, r.subject_id, 'active');
      END IF;
    END IF;

    UPDATE public.student_add_subject_requests
       SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
           handled_by = auth.uid(),
           handled_at = now(),
           handled_by_role = 'super'::public.subject_admin_role
     WHERE id = r.id;

    INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
    VALUES (
      auth.uid(),
      'add_subject_' || CASE WHEN p_approve THEN 'approve' ELSE 'reject' END,
      'student_add_subject_requests', r.id,
      jsonb_build_object('student_id', r.student_id, 'subject_id', r.subject_id)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_add_subject_requests(UUID[], BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_add_subject_requests(UUID[], BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.handle_add_subject_requests(UUID[], BOOLEAN) TO authenticated;

-- إشعارات المادة ٣٥: الأدمن يكتب/يقرأ إشعارات موادّه فقط.
DROP POLICY IF EXISTS law_notifications_admin_all ON public.attendance_notifications;
CREATE POLICY law_notifications_admin_all ON public.attendance_notifications
  FOR ALL USING (
    public.is_super_admin()
    OR (public.is_admin() AND (public.admin_subject_scope() IS NULL OR subject_id = ANY(public.admin_subject_scope())))
  ) WITH CHECK (
    public.is_super_admin()
    OR (public.is_admin() AND (public.admin_subject_scope() IS NULL OR subject_id = ANY(public.admin_subject_scope())))
  );

-- ══════════════════════════════════════════════════════════════════════
-- 8) إعادة تسمية حساب الدكتور: «د. اختبار صولفيج» → «دكتورة شيماء حجازى»
-- ══════════════════════════════════════════════════════════════════════
UPDATE public.admins
   SET full_name = 'دكتورة شيماء حجازى',
       full_name_ar = 'دكتورة شيماء حجازى',
       full_name_en = 'Dr. Shaimaa Hijazi'
 WHERE lower(email) = 'dr.shaimaa-hijazi@gmail.com';

-- إسناد افتراضي: صلاحية «طلبات تسجيل الطلاب» مسحوبة من كل أدمن مادة عند التطبيق
-- (تُمنح فرديًا من لوحة المشرف العام بعد ذلك).
INSERT INTO public.admin_permissions (admin_id, can_review_registrations)
SELECT a.id, FALSE
  FROM public.admins a
  WHERE NOT public.is_super_admin(a.id)
ON CONFLICT (admin_id) DO NOTHING;
