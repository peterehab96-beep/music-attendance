-- ══════════════════════════════════════════════════════════════════════
-- 027_subject_admins_and_add_subjects.sql
-- نظام أدمن كل مادة (الدكتور المسؤول عن مادته فقط) + طلبات الطالب
-- «إضافة مواد دراسية» بموافقة أدمن المادة أو الأدمن العام.
-- + عدّاد «تغيير كلمة المرور مباشرة» (3 مرات لكل ترم، يُصفَّر مع الترم الجديد).
--
-- الأدمن العام الوحيد: peterehab96@gmail.com — يرى كل المواد والكل إدارات.
-- أدمن المادة: يرى موادّه فقط (طلابها وحضورها ودرجاتها) ولا يرى غيرها.
-- ══════════════════════════════════════════════════════════════════════

-- ── 2) جدول أدمن المواد (صف لكل مادة مسندة لحساب) ──
DO $$ BEGIN
  CREATE TYPE public.subject_admin_role AS ENUM ('subject', 'super');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.subject_admins (
  admin_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
  role public.subject_admin_role NOT NULL DEFAULT 'subject',
  assigned_by UUID REFERENCES auth.users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (admin_id, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_subject_admins_subject ON public.subject_admins(subject_id);

ALTER TABLE public.subject_admins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subject_admins_admin_read ON public.subject_admins;
CREATE POLICY subject_admins_admin_read ON public.subject_admins
  FOR SELECT USING (public.is_admin());
DROP POLICY IF EXISTS subject_admins_super_write ON public.subject_admins;
CREATE POLICY subject_admins_super_write ON public.subject_admins
  FOR ALL USING (public.is_super_admin(auth.uid())) WITH CHECK (public.is_super_admin(auth.uid()));

-- ── 1) التمييز بين الأدمن العام وأدمن المادة ──
CREATE OR REPLACE FUNCTION public.is_super_admin(p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admins a
    JOIN auth.users u ON u.id = a.id
    WHERE a.id = p_user_id AND lower(u.email) = 'peterehab96@gmail.com'
  )
  OR EXISTS (
    SELECT 1 FROM public.subject_admins WHERE admin_id = p_user_id AND role = 'super'
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_super_admin(UUID) TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.is_subject_admin_for(p_admin_id UUID, p_subject_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_super_admin(p_admin_id)
      OR EXISTS (
        SELECT 1 FROM public.subject_admins
        WHERE admin_id = p_admin_id AND subject_id = p_subject_id
      );
$$;
GRANT EXECUTE ON FUNCTION public.is_subject_admin_for(UUID, UUID) TO authenticated;

-- المواد المسندة إلى أدمن معين. للأدمن العام ترجع NULL (يعني: كل المواد).
CREATE OR REPLACE FUNCTION public.my_admin_subject_ids(p_admin_id UUID DEFAULT auth.uid())
RETURNS UUID[]
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN public.is_super_admin(p_admin_id) THEN NULL
    ELSE COALESCE(
      (SELECT array_agg(sa.subject_id) FROM public.subject_admins sa WHERE sa.admin_id = p_admin_id),
      ARRAY[]::UUID[])
  END;
$$;
GRANT EXECUTE ON FUNCTION public.my_admin_subject_ids(UUID) TO authenticated;

-- ── 3) عدادات كلمة المرور: مرة واحدة لكل ترم لكل ميزة ──
ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS password_change_direct_used SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE public.students
  DROP CONSTRAINT IF EXISTS students_password_change_direct_used_check;
ALTER TABLE public.students
  ADD CONSTRAINT students_password_change_direct_used_check
  CHECK (password_change_direct_used BETWEEN 0 AND 3);

-- التصفير التلقائي مع بداية ترم جديد (مثل عدّاد طلبات إعادة التعيين):
CREATE OR REPLACE FUNCTION public.reset_password_counters_on_term_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.password_reset_requests_used := 0;
  NEW.password_change_direct_used := 0;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS students_password_counters_term_reset ON public.students;
CREATE TRIGGER students_password_counters_term_reset
  BEFORE UPDATE OF term ON public.students
  FOR EACH ROW EXECUTE FUNCTION public.reset_password_counters_on_term_change();

-- زيادة عدّاد "التغيير المباشر" بعد نجاح التغيير فقط (تستدعيها الوظيفي
-- student-change-own-password السري). تعدّاد يمنع السباق:
CREATE OR REPLACE FUNCTION public.student_can_direct_change_password(p_student_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_used SMALLINT;
BEGIN
  SELECT password_change_direct_used INTO v_used
  FROM public.students WHERE id = p_student_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'الطالب غير موجود'; END IF;
  RETURN COALESCE(v_used, 0) < 3;
END;
$$;
REVOKE ALL ON FUNCTION public.student_can_direct_change_password(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.student_can_direct_change_password(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.student_can_direct_change_password(UUID) FROM authenticated;

CREATE OR REPLACE FUNCTION public.student_consume_direct_change(p_student_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  UPDATE public.students
     SET password_change_direct_used = LEAST(COALESCE(password_change_direct_used, 0) + 1, 3)
   WHERE id = p_student_id;
END;
$$;
REVOKE ALL ON FUNCTION public.student_consume_direct_change(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.student_consume_direct_change(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.student_consume_direct_change(UUID) FROM authenticated;

-- ── 4) طلبات إضافة مواد دراسية من الطالب ──
CREATE TABLE IF NOT EXISTS public.student_add_subject_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
  level SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 4),
  term public.academic_term NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  handled_by UUID REFERENCES auth.users(id),
  handled_at TIMESTAMPTZ,
  handled_by_role public.subject_admin_role,
  UNIQUE (student_id, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_add_subj_req_pending ON public.student_add_subject_requests(status);
CREATE INDEX IF NOT EXISTS idx_add_subj_req_student ON public.student_add_subject_requests(student_id);

ALTER TABLE public.student_add_subject_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS add_subj_self_read ON public.student_add_subject_requests;
CREATE POLICY add_subj_self_read ON public.student_add_subject_requests
  FOR SELECT USING (auth.uid() = student_id OR public.is_admin());
DROP POLICY IF EXISTS add_subj_self_insert ON public.student_add_subject_requests;
CREATE POLICY add_subj_self_insert ON public.student_add_subject_requests
  FOR INSERT WITH CHECK (auth.uid() = student_id);

-- ── 5) الطالب يرسل طلبات المواد (دفعة واحدة) ──
CREATE OR REPLACE FUNCTION public.request_add_subjects(p_subject_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_student public.students%ROWTYPE;
  v_subject_count INTEGER;
  v_count INTEGER := 0;
BEGIN
  SELECT * INTO v_student FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'غير مصرح — حساب طالب فقط'; END IF;
  IF v_student.status <> 'approved' THEN
    RAISE EXCEPTION 'حسابك غير معتمد بعد — تُتاح إضافة المواد بعد اعتماد الإدمن';
  END IF;
  IF v_student.term <> 'term1' THEN
    RAISE EXCEPTION 'حاليًا الترم الأول فقط مفعّل لإضافة المواد';
  END IF;

  -- المواد المطلوبة يجب أن تخص فرقة الطالب والترم الأول فقط
  SELECT COUNT(*) INTO v_subject_count FROM public.subjects s
  WHERE s.id = ANY(COALESCE(p_subject_ids, ARRAY[]::UUID[]))
    AND s.level = v_student.level AND s.term = v_student.term;
  IF v_subject_count <> COALESCE(array_length(p_subject_ids, 1), 0) OR v_subject_count = 0 THEN
    RAISE EXCEPTION 'اختيار المواد غير مطابق لفرقتك والترم الحالي';
  END IF;

  -- المواد المسجلة سابقًا (نشطة/موازية) مستثناة تلقائيًا — لا تُعاد.
  INSERT INTO public.student_add_subject_requests (student_id, subject_id, level, term)
  SELECT v_student.id, s.id, v_student.level, v_student.term
  FROM unnest(COALESCE(p_subject_ids, ARRAY[]::UUID[])) AS sid(s)
  JOIN public.subjects s ON s.id = sid.s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.student_add_subject_requests r
    WHERE r.student_id = v_student.id AND r.subject_id = s.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.student_subjects ss
    WHERE ss.student_id = v_student.id AND ss.subject_id = s.id AND ss.status IN ('active', 'parallel')
  )
  ON CONFLICT (student_id, subject_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_add_subjects(UUID[]) TO authenticated;

-- ── 6) الموافقة/الرفض: أدمن المادة نفسه أو الأدمن العام فقط ──
CREATE OR REPLACE FUNCTION public.handle_add_subject_requests(
  p_request_ids UUID[],
  p_approve BOOLEAN
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  r RECORD;
  v_count INTEGER := 0;
BEGIN
  IF p_request_ids IS NULL THEN RETURN 0; END IF;

  FOR r IN
    SELECT * FROM public.student_add_subject_requests
    WHERE id = ANY(p_request_ids) AND status = 'pending'
  LOOP
    IF NOT public.is_subject_admin_for(auth.uid(), r.subject_id) THEN
      RAISE EXCEPTION 'غير مصرح — هذه المادة ليست ضمن مسؤوليتك';
    END IF;

    IF p_approve THEN
      -- نفس آلية التسجيل الأول بالضبط: صف enrollment نشط. الحضور والدرجات
      -- المحسوبة حيًّا من هذا الصف → المادة تعمل فورًا بنفس النظام كله.
      INSERT INTO public.student_subjects (student_id, subject_id, status)
      VALUES (r.student_id, r.subject_id, 'active')
      ON CONFLICT (student_id, subject_id) DO UPDATE
        SET status = 'active'
        WHERE public.student_subjects.status NOT IN ('active', 'parallel');
    END IF;

    UPDATE public.student_add_subject_requests
       SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
           handled_by = auth.uid(),
           handled_at = now(),
           handled_by_role = CASE WHEN public.is_super_admin() THEN 'super' ELSE 'subject' END
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
GRANT EXECUTE ON FUNCTION public.handle_add_subject_requests(UUID[], BOOLEAN) TO authenticated;

-- ── 7) قائمة الطلبات المعلقة ليطرحها أدمن المادة (يرى موادّه فقط) ──
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
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
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
    AND (public.my_admin_subject_ids() IS NULL OR r.subject_id = ANY(my_admin_subject_ids()))
  ORDER BY r.requested_at;
END;
$$;
GRANT EXECUTE ON FUNCTION public.pending_add_subject_requests() TO authenticated;

-- الطلبات المقبولة/المرفوضة (لعرض رصيد طلبات الطالب سابقًا) — للطالب نفسه:
CREATE OR REPLACE FUNCTION public.my_add_subject_requests()
RETURNS TABLE (
  request_id UUID,
  subject_id UUID,
  subject_name TEXT,
  term public.academic_term,
  status TEXT,
  requested_at TIMESTAMPTZ,
  handled_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  RETURN QUERY
  SELECT r.id, r.subject_id, s.name_ar, r.term, r.status, r.requested_at, r.handled_at
  FROM public.student_add_subject_requests r
  JOIN public.subjects s ON s.id = r.subject_id
  WHERE r.student_id = auth.uid()
  ORDER BY r.requested_at DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.my_add_subject_requests() TO authenticated;

-- ── 8) إدارة حسابات أدمن المواد — المشرف العام فقط ──
CREATE OR REPLACE FUNCTION public.super_create_subject_admin(
  p_email TEXT, p_password TEXT, p_full_name TEXT, p_subject_ids UUID[]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth AS $$
DECLARE
  v_admin_id UUID;
  v_exists TEXT;
  v_email TEXT;
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'غير مصرح — المشرف العام فقط'; END IF;
  v_email := lower(btrim(p_email));
  IF v_email !~ '^[^@]+@[^@]+\.[^@]+$' THEN RAISE EXCEPTION 'بريد إلكتروني غير صحيح'; END IF;
  IF COALESCE(btrim(p_full_name), '') = '' THEN RAISE EXCEPTION 'اسم الأدمن مطلوب'; END IF;
  IF COALESCE(array_length(p_subject_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'يجب إسناد مادة واحدة على الأقل';
  END IF;
  IF NOT (p_password ~ '[a-z]' AND p_password ~ '[A-Z]' AND p_password ~ '[0-9]' AND p_password ~ '[^A-Za-z0-9]') OR length(p_password) < 8 THEN
    RAISE EXCEPTION 'كلمة المرور يجب أن تشمل حرفًا كبيرًا وصغيرًا ورقمًا ورمزًا و8 أحرف على الأقل';
  END IF;

  SELECT email INTO v_exists FROM auth.users WHERE lower(email) = v_email;
  IF FOUND THEN RAISE EXCEPTION 'هذا البريد مستخدم بالفعل'; END IF;

  v_admin_id := gen_random_uuid();
  INSERT INTO auth.users (id, email, password, email_verified, created_at, updated_at)
  VALUES (v_admin_id, v_email, crypt(p_password, gen_salt('bf', 10)), true, now(), now());

  INSERT INTO public.admins (id, full_name, email, created_at)
  VALUES (v_admin_id, btrim(p_full_name), v_email, now());

  INSERT INTO public.subject_admins (admin_id, subject_id, role, assigned_by)
  SELECT v_admin_id, sid, 'subject'::public.subject_admin_role, auth.uid()
  FROM unnest(p_subject_ids) AS sid
  ON CONFLICT (admin_id, subject_id) DO NOTHING;

  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), 'create_subject_admin', 'admins', v_admin_id,
    jsonb_build_object('email', v_email, 'subjects', p_subject_ids));

  RETURN v_admin_id;
END;
$$;
REVOKE ALL ON FUNCTION public.super_create_subject_admin(TEXT, TEXT, TEXT, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.super_create_subject_admin(TEXT, TEXT, TEXT, UUID[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.super_create_subject_admin(TEXT, TEXT, TEXT, UUID[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.super_delete_subject_admin(p_admin_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth AS $$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'غير مصرح — المشرف العام فقط'; END IF;
  IF public.is_super_admin(p_admin_id) THEN
    RAISE EXCEPTION 'لا يمكن حذف المشرف العام';
  END IF;
  DELETE FROM public.subject_admins WHERE admin_id = p_admin_id;
  DELETE FROM public.admins WHERE id = p_admin_id;
  DELETE FROM auth.sessions WHERE user_id = p_admin_id;
  DELETE FROM auth.users WHERE id = p_admin_id;
  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), 'delete_subject_admin', 'admins', p_admin_id, '{}');
END;
$$;
REVOKE ALL ON FUNCTION public.super_delete_subject_admin(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.super_delete_subject_admin(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.super_delete_subject_admin(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.super_set_subject_admin_subjects(p_admin_id UUID, p_subject_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'غير مصرح — المشرف العام فقط'; END IF;
  DELETE FROM public.subject_admins WHERE admin_id = p_admin_id;
  INSERT INTO public.subject_admins (admin_id, subject_id, role, assigned_by)
  SELECT p_admin_id, sid, 'subject'::public.subject_admin_role, auth.uid()
  FROM unnest(COALESCE(p_subject_ids, ARRAY[]::UUID[])) AS sid;
  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), 'set_subject_admin_subjects', 'admins', p_admin_id, jsonb_build_object('subjects', p_subject_ids));
END;
$$;
REVOKE ALL ON FUNCTION public.super_set_subject_admin_subjects(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.super_set_subject_admin_subjects(UUID, UUID[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.super_set_subject_admin_subjects(UUID, UUID[]) TO authenticated;

-- قائمة حسابات أدمن المواد مع موادّهم (للنافذة الإدارية — للمشرف العام فقط):
CREATE OR REPLACE FUNCTION public.list_subject_admins()
RETURNS TABLE (admin_id UUID, full_name TEXT, email TEXT, subject_ids UUID[], created_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'غير مصرح — المشرف العام فقط'; END IF;
  RETURN QUERY
  SELECT a.id, a.full_name, a.email,
    COALESCE((SELECT array_agg(sa.subject_id ORDER BY sa.subject_id) FROM public.subject_admins sa WHERE sa.admin_id = a.id AND sa.role = 'subject'), ARRAY[]::UUID[]),
    a.created_at
  FROM public.admins a
  ORDER BY a.created_at;
END;
$$;
GRANT EXECUTE ON FUNCTION public.list_subject_admins() TO authenticated;

-- ── 9) حصر الوظائف الإدارية: أدمن المادة يرى/يعدّل مادته فقط ──

-- سجل الدرجات السري (بصريًا + جداول):
DROP FUNCTION IF EXISTS public.get_secret_grades(UUID);
CREATE OR REPLACE FUNCTION public.get_secret_grades(p_subject_id UUID DEFAULT NULL)
RETURNS TABLE (
  student_id UUID, student_name TEXT, national_id VARCHAR, subject_id UUID,
  subject_name TEXT, attended_sessions BIGINT, total_sessions BIGINT, max_grade SMALLINT,
  grade NUMERIC, enrollment_status TEXT, academic_year VARCHAR
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_ids UUID[];
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  v_ids := public.my_admin_subject_ids();
  RETURN QUERY
  SELECT
    st.id, st.full_name_ar, st.national_id, s.id, s.name_ar,
    (SELECT COUNT(DISTINCT al.session_id) FROM public.attendance_logs al
      JOIN public.lecture_sessions ls ON ls.id = al.session_id
      WHERE al.student_id = st.id AND ls.subject_id = s.id AND ls.closed_at IS NOT NULL),
    (SELECT COUNT(*) FROM public.lecture_sessions ls WHERE ls.subject_id = s.id AND ls.closed_at IS NOT NULL),
    s.max_grade,
    COALESCE(ss.year_work_grade, public.calculate_secret_grade(st.id, s.id)),
    ss.status::TEXT,
    ss.academic_year
  FROM public.student_subjects ss
  JOIN public.students st ON st.id = ss.student_id
  JOIN public.subjects s ON s.id = ss.subject_id
  WHERE (p_subject_id IS NULL OR s.id = p_subject_id)
    AND (v_ids IS NULL OR s.id = ANY(v_ids))
  ORDER BY st.full_name_ar;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_secret_grades(UUID) TO authenticated;

-- تعديل درجة/اسم — مادته فقط:
CREATE OR REPLACE FUNCTION public.admin_update_student_grade(
  p_student_id UUID, p_subject_id UUID, p_student_name TEXT, p_grade NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF NOT public.is_subject_admin_for(auth.uid(), p_subject_id) THEN
    RAISE EXCEPTION 'غير مصرح — هذه المادة ليست ضمن مسؤوليتك';
  END IF;
  UPDATE public.students SET full_name_ar = btrim(p_student_name) WHERE id = p_student_id;
  UPDATE public.student_subjects SET year_work_grade = p_grade
  WHERE student_id = p_student_id AND subject_id = p_subject_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_update_student_grade(UUID, UUID, TEXT, NUMERIC) TO authenticated;

-- إضافة طالب يدويًا — مادته فقط:
DROP FUNCTION IF EXISTS public.admin_quick_add_student(VARCHAR, TEXT, UUID, NUMERIC);
CREATE OR REPLACE FUNCTION public.admin_quick_add_student(
  p_national_id VARCHAR, p_full_name_ar TEXT, p_subject_id UUID, p_grade NUMERIC DEFAULT NULL
)
RETURNS TABLE (
  student_id UUID, student_name TEXT, national_id VARCHAR, subject_id UUID,
  subject_name TEXT, attended_sessions BIGINT, total_sessions BIGINT, max_grade SMALLINT,
  grade NUMERIC, enrollment_status TEXT, academic_year VARCHAR
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth AS $$
#variable_conflict use_column
DECLARE
  v_user_id UUID;
  v_subject public.subjects%ROWTYPE;
  v_email TEXT;
  v_clean_nid TEXT;
  v_existing_ss UUID;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF NOT public.is_subject_admin_for(auth.uid(), p_subject_id) THEN
    RAISE EXCEPTION 'غير مصرح — هذه المادة ليست ضمن مسؤوليتك';
  END IF;

  SELECT * INTO v_subject FROM public.subjects WHERE id = p_subject_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'المادة غير موجودة'; END IF;

  v_clean_nid := regexp_replace(p_national_id, '[^0-9]', '', 'g');
  IF v_clean_nid !~ '^(\d{8}|\d{9}|\d{14})$' THEN
    RAISE EXCEPTION 'الرقم يجب أن يتكون من 14 رقمًا (قومي مصري) أو من 8 إلى 9 أرقام (مدني عماني)';
  END IF;

  INSERT INTO public.national_ids (national_id, full_name_reference, level, is_claimed)
  VALUES (v_clean_nid, btrim(p_full_name_ar), v_subject.level, true)
  ON CONFLICT (national_id) DO UPDATE
  SET is_claimed = true, full_name_reference = COALESCE(public.national_ids.full_name_reference, btrim(p_full_name_ar));

  SELECT s.id INTO v_user_id FROM public.students s WHERE s.national_id = v_clean_nid;

  IF v_user_id IS NULL THEN
    v_user_id := gen_random_uuid();
    v_email := 'student_' || v_clean_nid || '@zu.edu.eg';
    INSERT INTO auth.users (id, email, password, email_verified, created_at, updated_at)
    VALUES (v_user_id, v_email, crypt(v_clean_nid || 'Aa1!', gen_salt('bf', 10)), true, now(), now())
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.students (id, national_id, full_name_ar, full_name_en, email, level, term, status, approved_at, approved_by)
    VALUES (v_user_id, v_clean_nid, btrim(p_full_name_ar), 'Student ' || v_clean_nid, v_email, v_subject.level, v_subject.term, 'approved', now(), auth.uid());
    UPDATE public.national_ids n SET claimed_by = v_user_id WHERE n.national_id = v_clean_nid;
  ELSE
    UPDATE public.students SET full_name_ar = btrim(p_full_name_ar) WHERE id = v_user_id;
  END IF;

  SELECT ss.id INTO v_existing_ss FROM public.student_subjects ss
  WHERE ss.student_id = v_user_id AND ss.subject_id = p_subject_id LIMIT 1;

  IF v_existing_ss IS NOT NULL THEN
    UPDATE public.student_subjects
    SET year_work_grade = COALESCE(p_grade, public.student_subjects.year_work_grade), status = 'active'
    WHERE id = v_existing_ss;
  ELSE
    INSERT INTO public.student_subjects (student_id, subject_id, status, year_work_grade)
    VALUES (v_user_id, p_subject_id, 'active', p_grade);
  END IF;

  RETURN QUERY
  SELECT st.id, st.full_name_ar, st.national_id, s.id, s.name_ar,
    0::BIGINT,
    (SELECT COUNT(*) FROM public.lecture_sessions ls WHERE ls.subject_id = s.id AND ls.closed_at IS NOT NULL),
    s.max_grade,
    COALESCE(p_grade, 0::NUMERIC),
    'active'::TEXT,
    ss.academic_year
  FROM public.students st
  JOIN public.subjects s ON s.id = p_subject_id
  LEFT JOIN public.student_subjects ss ON ss.student_id = st.id AND ss.subject_id = s.id
  WHERE st.id = v_user_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_quick_add_student(VARCHAR, TEXT, UUID, NUMERIC) TO authenticated;

-- قانون ٣٥ — الالتزام (مُصفى على موادّه):
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
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  v_ids := public.my_admin_subject_ids();
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
  ORDER BY st.level, s.name_ar, st.full_name_ar;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_attendance_compliance(SMALLINT, UUID) TO authenticated;

-- تنفيذ القانون — مادته فقط:
CREATE OR REPLACE FUNCTION public.execute_attendance_law(p_student_id UUID, p_subject_id UUID)
RETURNS TABLE (action_type TEXT, action_number INTEGER, deducted_grade NUMERIC, is_banned BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_attended BIGINT;
  v_total BIGINT;
  v_warnings INTEGER;
  v_deductions INTEGER;
  v_ordinal INTEGER;
  v_percent NUMERIC;
  v_zero_max BOOLEAN;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF NOT public.is_subject_admin_for(auth.uid(), p_subject_id) THEN
    RAISE EXCEPTION 'غير مصرح — هذه المادة ليست ضمن مسؤوليتك';
  END IF;

  SELECT COUNT(*) INTO v_total FROM public.lecture_sessions ls
  WHERE ls.subject_id = p_subject_id AND ls.closed_at IS NOT NULL;

  SELECT COUNT(DISTINCT al.session_id) INTO v_attended
  FROM public.attendance_logs al JOIN public.lecture_sessions ls ON ls.id = al.session_id
  WHERE al.student_id = p_student_id AND ls.subject_id = p_subject_id AND ls.closed_at IS NOT NULL;

  SELECT
    COUNT(*) FILTER (WHERE action_type = 'warning'),
    COUNT(*) FILTER (WHERE action_type = 'deduction')
  INTO v_warnings, v_deductions
  FROM public.attendance_law_actions
  WHERE student_id = p_student_id AND subject_id = p_subject_id;

  v_percent := CASE WHEN COALESCE(v_total, 0) = 0 THEN 100
    ELSE ROUND(v_attended::NUMERIC * 100 / v_total, 1) END;

  SELECT max_grade = 0 INTO v_zero_max FROM public.subjects WHERE id = p_subject_id;

  v_ordinal := COALESCE(v_warnings, 0) + COALESCE(v_deductions, 0) + 1;

  IF v_ordinal <= 2 THEN
    INSERT INTO public.attendance_law_actions
      (student_id, subject_id, action_type, action_number, attendance_count, total_sessions, attendance_percent, deducted_grade, executed_by)
    VALUES (p_student_id, p_subject_id, 'warning'::TEXT, v_ordinal, v_attended, v_total, v_percent, NULL, auth.uid())
    ON CONFLICT (student_id, subject_id, action_number) DO NOTHING;

    INSERT INTO public.attendance_notifications (student_id, subject_id, kind, title, body, attendance_percent)
    SELECT p_student_id, p_subject_id, 'warning' || v_ordinal,
      'إنذار ' || CASE WHEN v_ordinal = 1 THEN 'أول' ELSE 'ثانٍ' END || ' — ' || s.name_ar,
      'نسبة حضورك في هذه المادة ' || v_percent || '% وهي أقل من الحد (75%). انتظامك ضروري لتجنب الحرمان وفقًا للمادة ٣٥.',
      v_percent
    FROM public.subjects s WHERE s.id = p_subject_id
    ON CONFLICT (student_id, subject_id, kind) DO NOTHING;

    RETURN QUERY SELECT 'warning'::TEXT, v_ordinal, NULL::NUMERIC, FALSE;
  ELSE
    IF COALESCE(v_zero_max, FALSE) THEN
      RETURN QUERY SELECT 'deduction'::TEXT, v_ordinal, 0::NUMERIC, TRUE;
    ELSE
      UPDATE public.student_subjects
         SET year_work_grade = GREATEST(COALESCE(year_work_grade, 0) - 1, 0)
       WHERE student_id = p_student_id AND subject_id = p_subject_id;

      INSERT INTO public.attendance_law_actions
        (student_id, subject_id, action_type, action_number, attendance_count, total_sessions, attendance_percent, deducted_grade, executed_by)
      VALUES (p_student_id, p_subject_id, 'deduction'::TEXT, v_ordinal, v_attended, v_total, v_percent, 1, auth.uid())
      ON CONFLICT (student_id, subject_id, action_number) DO NOTHING;
      RETURN QUERY SELECT 'deduction'::TEXT, v_ordinal, 1::NUMERIC, TRUE;

      INSERT INTO public.attendance_notifications (student_id, subject_id, kind, title, body, attendance_percent)
      SELECT p_student_id, p_subject_id, 'deprivation',
        'تنبيه حرمان — ' || s.name_ar,
        'لقد تجاوزت الحد المسموح به للغياب في هذه المادة (نسبة الحضور ' || v_percent || '%). وفقًا للمادة ٣٥ تُحرم من دخول الامتحان النهائي لهذه المادة.',
        v_percent
      FROM public.subjects s WHERE s.id = p_subject_id
      ON CONFLICT (student_id, subject_id, kind) DO NOTHING;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), 'execute_attendance_law', 'students', p_student_id,
    jsonb_build_object('subject_id', p_subject_id, 'ordinal', v_ordinal));
END;
$$;
GRANT EXECUTE ON FUNCTION public.execute_attendance_law(UUID, UUID) TO authenticated;

-- التراجع — مادته فقط (نفس تعريف 018 مع الحارس):
CREATE OR REPLACE FUNCTION public.undo_attendance_law(p_student_id UUID, p_subject_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_deducted NUMERIC;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF NOT public.is_subject_admin_for(auth.uid(), p_subject_id) THEN
    RAISE EXCEPTION 'غير مصرح — هذه المادة ليست ضمن مسؤوليتك';
  END IF;

  SELECT COALESCE(SUM(deducted_grade), 0) INTO v_deducted
  FROM public.attendance_law_actions
  WHERE student_id = p_student_id AND subject_id = p_subject_id AND deducted_grade IS NOT NULL;

  DELETE FROM public.attendance_law_actions
  WHERE student_id = p_student_id AND subject_id = p_subject_id;

  DELETE FROM public.attendance_notifications
  WHERE student_id = p_student_id AND subject_id = p_subject_id;

  IF COALESCE(v_deducted, 0) > 0 THEN
    UPDATE public.student_subjects
       SET year_work_grade = LEAST(COALESCE(year_work_grade, 0) + v_deducted,
         (SELECT max_grade FROM public.subjects WHERE id = p_subject_id))
     WHERE student_id = p_student_id AND subject_id = p_subject_id;
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.undo_attendance_law(UUID, UUID) TO authenticated;

-- إضافة حضور لاحق — مادته فقط:
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
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  SELECT * INTO v_session FROM public.lecture_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'not_found'::TEXT, 'الجلسة غير موجودة'::TEXT, FALSE, NULL::UUID, NULL::TEXT, NULL::VARCHAR, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT;
    RETURN;
  END IF;
  IF NOT public.is_subject_admin_for(auth.uid(), v_session.subject_id) THEN
    RETURN QUERY SELECT FALSE, 'forbidden'::TEXT, 'غير مصرح — هذه المادة ليست ضمن مسؤوليتك'::TEXT, FALSE, NULL::UUID, NULL::TEXT, NULL::VARCHAR, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_student FROM public.students WHERE national_id = regexp_replace(p_national_id, '[^0-9]', '', 'g');
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'not_enrolled'::TEXT, 'لا يوجد طالب بهذا الرقم'::TEXT, FALSE, NULL::UUID, NULL::TEXT, NULL::VARCHAR, NULL::UUID, NULL::TIMESTAMPTZ, NULL::TEXT;
    RETURN;
  END IF;

  SELECT al.id INTO v_existing FROM public.attendance_logs al
  WHERE al.session_id = p_session_id AND al.student_id = v_student.id;

  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT TRUE, 'already'::TEXT, NULL::TEXT, TRUE, v_student.id, v_student.full_name_ar, v_student.national_id, v_existing, NULL::TIMESTAMPTZ, 'كان مسجلًا في هذه الجلسة بالفعل'::TEXT;
    RETURN;
  END IF;

  INSERT INTO public.attendance_logs (session_id, student_id, latitude, longitude, distance_meters, webauthn_credential_id)
  VALUES (p_session_id, v_student.id, NULL, NULL, 0, 'manual_admin')
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), 'admin_add_retro_attendance', 'attendance_logs', v_id,
    jsonb_build_object('student_id', v_student.id, 'session_id', p_session_id));

  RETURN QUERY SELECT TRUE, 'ok'::TEXT, NULL::TEXT, FALSE, v_student.id, v_student.full_name_ar, v_student.national_id, v_id, now(), 'تم تسجيل حضوره بوقت الجلسة'::TEXT;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_add_retro_attendance(UUID, VARCHAR) TO authenticated;

-- فتح محاضرة — أدمن المادة أو الأدمن العام هم فقط من يفتح، وفي مادته:
CREATE OR REPLACE FUNCTION public.admin_open_lecture(p_subject_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF NOT public.is_subject_admin_for(auth.uid(), p_subject_id) THEN
    RAISE EXCEPTION 'غير مصرح — هذه المادة ليست ضمن مسؤوليتك';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.lecture_sessions WHERE subject_id = p_subject_id AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'توجد محاضرة نشطة لهذه المادة بالفعل.';
  END IF;
  INSERT INTO public.lecture_sessions (subject_id, opened_by)
  VALUES (p_subject_id, auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_open_lecture(UUID) TO authenticated;

-- محادثة: قائمة الجلسات الإدارية مُصفّاة:
DROP FUNCTION IF EXISTS public.get_admin_lecture_sessions();
CREATE OR REPLACE FUNCTION public.get_admin_lecture_sessions()
RETURNS TABLE (
  id UUID, subject_id UUID, opened_by UUID, opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ, is_active BOOLEAN, subjects JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_ids UUID[];
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  v_ids := public.my_admin_subject_ids();
  RETURN QUERY
  SELECT ls.id, ls.subject_id, ls.opened_by, ls.opened_at, ls.closed_at, ls.is_active,
    to_jsonb(s.*) /* BB */
  FROM public.lecture_sessions ls
  JOIN public.subjects s ON s.id = ls.subject_id
  WHERE (v_ids IS NULL OR ls.subject_id = ANY(v_ids))
  ORDER BY ls.opened_at DESC LIMIT 500;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_admin_lecture_sessions() TO authenticated;

-- ── 10) سياسات صارمة على الجداول — أدمن المادة لا يلمس غير مادته عبر الواجهة ──
DROP POLICY IF EXISTS sessions_admin_write ON public.lecture_sessions;
CREATE POLICY sessions_admin_write ON public.lecture_sessions
  FOR INSERT WITH CHECK (public.is_subject_admin_for(auth.uid(), subject_id));
DROP POLICY IF EXISTS sessions_admin_update ON public.lecture_sessions;
CREATE POLICY sessions_admin_update ON public.lecture_sessions
  FOR UPDATE USING (public.is_subject_admin_for(auth.uid(), subject_id))
  WITH CHECK (public.is_subject_admin_for(auth.uid(), subject_id));

DROP POLICY IF EXISTS attendance_self_or_admin ON public.attendance_logs;
CREATE POLICY attendance_self_or_admin ON public.attendance_logs
  FOR SELECT USING (
    auth.uid() = student_id
    OR public.is_super_admin()
    OR public.is_admin() AND EXISTS (
      SELECT 1 FROM public.lecture_sessions ls
      JOIN public.subject_admins sa ON sa.subject_id = ls.subject_id
      WHERE ls.id = session_id AND sa.admin_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS notifications_student_read ON public.attendance_notifications;
CREATE POLICY notifications_student_read ON public.attendance_notifications
  FOR SELECT USING (auth.uid() = student_id);

-- ── 11) تسجيل الأدمن العام الحالي بصف super في subject_admins ──
-- (يُنفَّذ مرة واحدة تلقائيًا عند التطبيق)
INSERT INTO public.subject_admins (admin_id, subject_id, role)
SELECT a.id, s.id, 'super'
FROM public.admins a
JOIN auth.users u ON u.id = a.id
JOIN public.subjects s ON TRUE
WHERE lower(u.email) = 'peterehab96@gmail.com'
ON CONFLICT (admin_id, subject_id) DO NOTHING;
