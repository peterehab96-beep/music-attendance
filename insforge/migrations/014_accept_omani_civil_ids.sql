-- 014_accept_omani_civil_ids.sql
-- يقبل: الرقم القومي المصري (14 رقمًا) أو الرقم المدني العماني (من 6 إلى 9 أرقام)
-- يشمل: قيود CHECK على national_ids وstudents + دوال import_national_ids
--       وregister_student وadmin_quick_add_student

-- ═══════════════════════════════════════════════════════════════
-- 1. قيود الجداول
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.national_ids ALTER COLUMN national_id TYPE VARCHAR(14);
ALTER TABLE public.national_ids DROP CONSTRAINT IF EXISTS valid_id_format;
ALTER TABLE public.national_ids DROP CONSTRAINT IF EXISTS national_ids_national_id_check;
ALTER TABLE public.national_ids ADD CONSTRAINT valid_id_format CHECK (national_id ~ '^(\d{6,9}|\d{14})$');

ALTER TABLE public.students ALTER COLUMN national_id TYPE VARCHAR(14);
ALTER TABLE public.students DROP CONSTRAINT IF EXISTS valid_student_id_format;
ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_national_id_check;
ALTER TABLE public.students ADD CONSTRAINT valid_student_id_format CHECK (national_id ~ '^(\d{6,9}|\d{14})$');

-- ═══════════════════════════════════════════════════════════════
-- 2. import_national_ids — نفس تعريف 006 مع النمط الجديد
-- ═══════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.import_national_ids(UUID, JSONB);
CREATE FUNCTION public.import_national_ids(p_admin_id UUID, p_rows JSONB)
RETURNS TABLE (inserted_count INTEGER, updated_count INTEGER, skipped_claimed_count INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row JSONB;
  v_id TEXT;
  v_level SMALLINT;
  v_existing public.national_ids%ROWTYPE;
BEGIN
  IF NOT public.is_admin(p_admin_id) THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  inserted_count := 0; updated_count := 0; skipped_claimed_count := 0;
  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    v_id := regexp_replace(COALESCE(v_row->>'national_id', ''), '[^0-9]', '', 'g');
    v_level := NULLIF(v_row->>'level', '')::SMALLINT;
    -- 14 رقمًا (مصري) أو من 6 إلى 9 أرقام (عماني)
    IF v_id !~ '^(\d{6,9}|\d{14})$' OR (v_level IS NOT NULL AND v_level NOT BETWEEN 1 AND 4) THEN CONTINUE; END IF;
    SELECT * INTO v_existing FROM public.national_ids WHERE national_id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.national_ids (national_id, full_name_reference, level, uploaded_by)
      VALUES (v_id, NULLIF(trim(v_row->>'full_name_reference'), ''), v_level, p_admin_id);
      inserted_count := inserted_count + 1;
    ELSIF v_existing.is_claimed THEN
      skipped_claimed_count := skipped_claimed_count + 1;
    ELSE
      UPDATE public.national_ids
      SET full_name_reference = COALESCE(NULLIF(trim(v_row->>'full_name_reference'), ''), full_name_reference),
          level = COALESCE(v_level, level), uploaded_by = p_admin_id
      WHERE id = v_existing.id;
      updated_count := updated_count + 1;
    END IF;
  END LOOP;
  RETURN NEXT;
END;
$$;
GRANT EXECUTE ON FUNCTION public.import_national_ids(UUID, JSONB) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 3. register_student — نفس تعريف 006 مع النمط الجديد
-- ═══════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.register_student(VARCHAR, TEXT, TEXT, TEXT, SMALLINT, public.academic_term, UUID[]);
CREATE FUNCTION public.register_student(
  p_national_id VARCHAR(14), p_email TEXT, p_full_name_ar TEXT, p_full_name_en TEXT,
  p_level SMALLINT, p_term public.academic_term, p_subject_ids UUID[]
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id UUID := auth.uid(); v_claim public.national_ids%ROWTYPE; v_subject_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول قبل إكمال التسجيل'; END IF;
  IF p_level NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'الفرقة الدراسية غير صحيحة'; END IF;
  -- 14 رقمًا (مصري) أو من 6 إلى 9 أرقام (عماني)
  IF p_national_id !~ '^(\d{6,9}|\d{14})$' THEN RAISE EXCEPTION 'الرقم يجب أن يتكون من 14 رقمًا (قومي مصري) أو من 6 إلى 9 أرقام (مدني عماني)'; END IF;
  IF length(trim(p_full_name_ar)) < 3 OR length(trim(p_full_name_en)) < 3 THEN RAISE EXCEPTION 'الاسم غير مكتمل'; END IF;
  SELECT * INTO v_claim FROM public.national_ids WHERE national_id = p_national_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الرقم غير مسجل في قوائم الكلية'; END IF;
  IF v_claim.is_claimed = TRUE THEN RAISE EXCEPTION 'تم تسجيل هذا الرقم من قبل'; END IF;
  IF v_claim.level IS NOT NULL AND v_claim.level <> p_level THEN RAISE EXCEPTION 'الفرقة المختارة لا تطابق الفرقة المسجلة في قائمة الكلية'; END IF;
  SELECT COUNT(*) INTO v_subject_count FROM public.subjects s WHERE s.id = ANY(COALESCE(p_subject_ids, ARRAY[]::UUID[]))
    AND ((p_term <> 'summer' AND s.level = p_level AND s.term = p_term) OR (p_term = 'summer' AND s.term IN ('term1', 'term2') AND s.level <= p_level));
  IF v_subject_count <> COALESCE(array_length(p_subject_ids, 1), 0) OR v_subject_count = 0 THEN RAISE EXCEPTION 'اختيار المواد غير مطابق للفرقة والترم'; END IF;
  INSERT INTO public.students (id, national_id, full_name_ar, full_name_en, email, level, term)
  VALUES (v_user_id, p_national_id, trim(p_full_name_ar), trim(p_full_name_en), lower(trim(p_email)), p_level, p_term);
  INSERT INTO public.student_subjects (student_id, subject_id) SELECT v_user_id, s.id FROM public.subjects s WHERE s.id = ANY(p_subject_ids);
  UPDATE public.national_ids SET is_claimed = TRUE, claimed_by = v_user_id WHERE id = v_claim.id;
  RETURN v_user_id;
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'هذا الحساب أو الرقم مستخدم بالفعل'; END;
$$;
GRANT EXECUTE ON FUNCTION public.register_student(VARCHAR, TEXT, TEXT, TEXT, SMALLINT, public.academic_term, UUID[]) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 4. admin_quick_add_student — نفس تعريف 011 مع النمط الجديد
-- ═══════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.admin_quick_add_student(VARCHAR, TEXT, UUID, NUMERIC);

CREATE OR REPLACE FUNCTION public.admin_quick_add_student(
  p_national_id VARCHAR,
  p_full_name_ar TEXT,
  p_subject_id UUID,
  p_grade NUMERIC DEFAULT NULL
)
RETURNS TABLE (
  student_id UUID,
  student_name TEXT,
  national_id VARCHAR,
  subject_id UUID,
  subject_name TEXT,
  attended_sessions BIGINT,
  total_sessions BIGINT,
  max_grade SMALLINT,
  grade NUMERIC,
  enrollment_status TEXT,
  academic_year VARCHAR
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
#variable_conflict use_column
DECLARE
  v_user_id UUID;
  v_subject public.subjects%ROWTYPE;
  v_email TEXT;
  v_clean_nid TEXT;
  v_existing_ss UUID;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  SELECT * INTO v_subject FROM public.subjects WHERE id = p_subject_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'المادة غير موجودة'; END IF;

  v_clean_nid := regexp_replace(p_national_id, '[^0-9]', '', 'g');
  IF v_clean_nid !~ '^(\d{6,9}|\d{14})$' THEN
    RAISE EXCEPTION 'الرقم يجب أن يتكون من 14 رقمًا (قومي مصري) أو من 6 إلى 9 أرقام (مدني عماني)';
  END IF;

  INSERT INTO public.national_ids (national_id, full_name_reference, level, is_claimed)
  VALUES (v_clean_nid, trim(p_full_name_ar), v_subject.level, true)
  ON CONFLICT (national_id) DO UPDATE
  SET is_claimed = true, full_name_reference = COALESCE(public.national_ids.full_name_reference, trim(p_full_name_ar));

  SELECT s.id INTO v_user_id FROM public.students s WHERE s.national_id = v_clean_nid;

  IF v_user_id IS NULL THEN
    v_user_id := gen_random_uuid();
    v_email := 'student_' || v_clean_nid || '@zu.edu.eg';

    INSERT INTO auth.users (id, email, password, email_verified, created_at, updated_at)
    VALUES (v_user_id, v_email, crypt(v_clean_nid || 'Aa1!', gen_salt('bf', 10)), true, now(), now())
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.students (id, national_id, full_name_ar, full_name_en, email, level, term, status, approved_at, approved_by)
    VALUES (v_user_id, v_clean_nid, trim(p_full_name_ar), 'Student ' || v_clean_nid, v_email, v_subject.level, v_subject.term, 'approved', now(), auth.uid());

    UPDATE public.national_ids n SET claimed_by = v_user_id WHERE n.national_id = v_clean_nid;
  ELSE
    UPDATE public.students SET full_name_ar = trim(p_full_name_ar) WHERE id = v_user_id;
  END IF;

  SELECT ss.id INTO v_existing_ss FROM public.student_subjects ss
  WHERE ss.student_id = v_user_id AND ss.subject_id = p_subject_id
  LIMIT 1;

  IF v_existing_ss IS NOT NULL THEN
    UPDATE public.student_subjects
    SET year_work_grade = COALESCE(p_grade, public.student_subjects.year_work_grade), status = 'active'
    WHERE id = v_existing_ss;
  ELSE
    INSERT INTO public.student_subjects (student_id, subject_id, status, year_work_grade)
    VALUES (v_user_id, p_subject_id, 'active', p_grade);
  END IF;

  RETURN QUERY
  SELECT
    st.id,
    st.full_name_ar,
    st.national_id,
    s.id,
    s.name_ar,
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
