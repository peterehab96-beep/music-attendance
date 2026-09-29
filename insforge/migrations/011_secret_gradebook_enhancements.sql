-- 011_secret_gradebook_enhancements.sql
-- 1. Add year_work_grade column
ALTER TABLE public.student_subjects
  ADD COLUMN IF NOT EXISTS year_work_grade NUMERIC;

-- 2. Drop and recreate get_secret_grades
DROP FUNCTION IF EXISTS public.get_secret_grades(UUID);
DROP FUNCTION IF EXISTS public.get_secret_grades();

CREATE OR REPLACE FUNCTION public.get_secret_grades(p_subject_id UUID DEFAULT NULL)
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  RETURN QUERY
  SELECT 
    st.id, 
    st.full_name_ar, 
    st.national_id, 
    s.id, 
    s.name_ar,
    (SELECT COUNT(DISTINCT al.session_id) FROM public.attendance_logs al JOIN public.lecture_sessions ls ON ls.id = al.session_id WHERE al.student_id = st.id AND ls.subject_id = s.id AND ls.closed_at IS NOT NULL),
    (SELECT COUNT(*) FROM public.lecture_sessions ls WHERE ls.subject_id = s.id AND ls.closed_at IS NOT NULL),
    s.max_grade,
    COALESCE(ss.year_work_grade, public.calculate_secret_grade(st.id, s.id)),
    ss.status::TEXT,
    ss.academic_year
  FROM public.student_subjects ss
  JOIN public.students st ON st.id = ss.student_id
  JOIN public.subjects s ON s.id = ss.subject_id
  WHERE p_subject_id IS NULL OR s.id = p_subject_id
  ORDER BY st.full_name_ar;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_secret_grades(UUID) TO authenticated;

-- 3. Function to update student name and year work grade
DROP FUNCTION IF EXISTS public.admin_update_student_grade(UUID, UUID, TEXT, NUMERIC);

CREATE OR REPLACE FUNCTION public.admin_update_student_grade(
  p_student_id UUID,
  p_subject_id UUID,
  p_student_name TEXT,
  p_grade NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  UPDATE public.students
  SET full_name_ar = trim(p_student_name)
  WHERE id = p_student_id;

  UPDATE public.student_subjects
  SET year_work_grade = p_grade
  WHERE student_id = p_student_id AND subject_id = p_subject_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_update_student_grade(UUID, UUID, TEXT, NUMERIC) TO authenticated;

-- 4. Quick add student function
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
  IF v_clean_nid !~ '^(\d{8}|\d{9}|\d{14})$' THEN
    RAISE EXCEPTION 'الرقم القومي يجب أن يتكون من 8 أو 9 أو 14 رقمًا';
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
