-- 022_retroactive_attendance_rpc.sql
-- ميزتان للأدمن:
--   (1) إضافة حضور طالب لجلسة منتهية (سابقة) بالرقم القومي — فتحسب له درجة تلك الجلسة
--       وتظهر في لوحة تحكمه أنه حضر، دون الحاجة لإعادة فتح الجلسة.
--   (2) تعديل اسم الطالب (العربي + الإنجليزي فقط) — ينتشر الاسم الجديد في النظام كله
--       لأن كل الكشوفات والسجلات تقرأ الاسم حيًا من جدول students (JOIN على students).
--
-- كلا الدالتين محميتان بـ is_admin() وتسجلان أثرهما في audit_logs.
-- الرفض داخل الدالة يعود JSONB (بدل RAISE) لعرض رسالة واضحة في الواجهة.

-- ─── (1) إضافة حضور لجلسة منتهية بالرقم القومي ───
CREATE OR REPLACE FUNCTION public.admin_add_retro_attendance(
  p_session_id UUID,
  p_national_id VARCHAR
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_nid TEXT;
  v_student RECORD;
  v_session RECORD;
  v_attendance_id UUID;
  v_checked_at TIMESTAMPTZ;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_admin', 'error', 'غير مصرح — هذه العملية للأدمن فقط');
  END IF;

  v_nid := regexp_replace(COALESCE(p_national_id, ''), '[^0-9]', '', 'g');
  IF v_nid !~ '^(\d{6,9}|\d{14})$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'invalid_national_id', 'error', 'رقم غير صحيح: مطلوب 14 رقمًا (قومي مصري) أو 6–9 أرقام (مدني عماني)');
  END IF;

  SELECT id, subject_id, is_active, opened_at, closed_at INTO v_session
  FROM public.lecture_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'session_not_found', 'error', 'الجلسة غير موجودة');
  END IF;

  SELECT id, full_name_ar, national_id INTO v_student
  FROM public.students WHERE national_id = v_nid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'student_not_found', 'error', 'لا يوجد حساب طالب بهذا الرقم');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.student_subjects ss
    WHERE ss.student_id = v_student.id AND ss.subject_id = v_session.subject_id
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_enrolled', 'error',
      'الطالب ' || v_student.full_name_ar || ' غير مسجل في مادة هذه الجلسة');
  END IF;

  -- وقت الحضور يُعرض بوقت الجلسة نفسها (وقت الإقفال إن كانت مغلقة) ليتطابق الكشف مع زمن المحاضرة
  v_checked_at := COALESCE(v_session.closed_at, v_session.opened_at, NOW());

  INSERT INTO public.attendance_logs (session_id, student_id, checked_in_at, check_in_method)
  VALUES (p_session_id, v_student.id, v_checked_at, 'manual_admin')
  ON CONFLICT (session_id, student_id) DO NOTHING
  RETURNING id INTO v_attendance_id;

  IF v_attendance_id IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'already_present', TRUE,
      'student_id', v_student.id, 'student_name', v_student.full_name_ar,
      'national_id', v_student.national_id,
      'message', 'كان مسجلًا في هذه الجلسة بالفعل');
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'already_present', FALSE,
    'attendance_id', v_attendance_id,
    'student_id', v_student.id, 'student_name', v_student.full_name_ar,
    'national_id', v_student.national_id,
    'checked_in_at', v_checked_at,
    'message', 'تم تسجيل حضور الطالب بوقت هذه الجلسة');
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_add_retro_attendance(UUID, VARCHAR) TO authenticated;

-- ─── (2) تعديل اسم الطالب فقط (عربي + إنجليزي) ───
CREATE OR REPLACE FUNCTION public.admin_update_student_name(
  p_student_id UUID,
  p_full_name_ar TEXT,
  p_full_name_en TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_ar TEXT;
  v_en TEXT;
  v_old RECORD;
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'غير مصرح — هذه العملية للأدمن فقط');
  END IF;

  v_ar := COALESCE(trim(p_full_name_ar), '');
  v_en := COALESCE(trim(p_full_name_en), '');

  IF v_ar = '' OR v_en = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'الاسم بالعربية والإنجليزية مطلوبان معًا');
  END IF;

  SELECT id, full_name_ar, full_name_en INTO v_old FROM public.students WHERE id = p_student_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'الطالب غير موجود');
  END IF;

  UPDATE public.students
  SET full_name_ar = v_ar, full_name_en = v_en
  WHERE id = p_student_id;

  -- الاسم ينتشر في كل الكشوفات والسجلات تلقائيًا لأنها تقرأ students حيًا.
  -- trigger audit_students يسجل التعديل أيضًا. هنا نسجل تفصيل الاسم القديم/الجديد.
  INSERT INTO public.audit_logs (action, entity_type, entity_id, actor_id, metadata)
  VALUES ('admin_update_student_name', 'students', p_student_id, auth.uid(),
    jsonb_build_object('old_ar', v_old.full_name_ar, 'old_en', v_old.full_name_en,
      'new_ar', v_ar, 'new_en', v_en));

  RETURN jsonb_build_object('ok', TRUE, 'student_id', p_student_id,
    'full_name_ar', v_ar, 'full_name_en', v_en);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_update_student_name(UUID, TEXT, TEXT) TO authenticated;
