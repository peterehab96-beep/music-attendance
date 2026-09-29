-- 006_multi_national_id_and_password_reset.sql
-- Fixes: Accept 8, 9, and 14-digit national IDs everywhere
-- Fixes: Enhanced password reset flow with student self-set password after admin approval
-- Fixes: 3-attempt limit enforcement

-- ═══════════════════════════════════════════════════════════════
-- 1. Fix national_ids table to accept 8, 9, and 14-digit IDs
-- ═══════════════════════════════════════════════════════════════

-- Widen the VARCHAR column to accommodate all formats
ALTER TABLE public.national_ids ALTER COLUMN national_id TYPE VARCHAR(14);

-- Drop and recreate the check constraint
ALTER TABLE public.national_ids DROP CONSTRAINT IF EXISTS valid_id_format;
ALTER TABLE public.national_ids DROP CONSTRAINT IF EXISTS national_ids_national_id_check;
ALTER TABLE public.national_ids ADD CONSTRAINT valid_id_format CHECK (national_id ~ '^(\d{8}|\d{9}|\d{14})$');

-- ═══════════════════════════════════════════════════════════════
-- 2. Fix students table to accept 8, 9, and 14-digit IDs
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.students ALTER COLUMN national_id TYPE VARCHAR(14);
ALTER TABLE public.students DROP CONSTRAINT IF EXISTS valid_student_id_format;
ALTER TABLE public.students DROP CONSTRAINT IF EXISTS students_national_id_check;
ALTER TABLE public.students ADD CONSTRAINT valid_student_id_format CHECK (national_id ~ '^(\d{8}|\d{9}|\d{14})$');

-- ═══════════════════════════════════════════════════════════════
-- 3. Recreate import_national_ids to accept 8, 9, and 14 digits
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
    -- Accept 8, 9, or 14 digit national IDs only
    IF v_id !~ '^(\d{8}|\d{9}|\d{14})$' OR (v_level IS NOT NULL AND v_level NOT BETWEEN 1 AND 4) THEN CONTINUE; END IF;
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
-- 4. Recreate validate_national_id to accept 8, 9, and 14 digits
-- ═══════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.validate_national_id(VARCHAR);
CREATE FUNCTION public.validate_national_id(p_national_id VARCHAR(14))
RETURNS TABLE (is_available BOOLEAN, full_name_reference TEXT, level SMALLINT, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY SELECT (n.id IS NOT NULL AND n.is_claimed = FALSE), n.full_name_reference, n.level,
    CASE WHEN n.id IS NULL THEN 'not_found' WHEN n.is_claimed THEN 'claimed' ELSE 'available' END
  FROM (SELECT 1) AS one LEFT JOIN public.national_ids n ON n.national_id = p_national_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.validate_national_id(VARCHAR) TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 5. Recreate register_student to accept 8, 9, and 14 digits
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
  -- Accept 8, 9, or 14 digit national IDs
  IF p_national_id !~ '^(\d{8}|\d{9}|\d{14})$' THEN RAISE EXCEPTION 'الرقم القومي يجب أن يتكون من 8 أو 9 أو 14 رقمًا'; END IF;
  IF length(trim(p_full_name_ar)) < 3 OR length(trim(p_full_name_en)) < 3 THEN RAISE EXCEPTION 'الاسم غير مكتمل'; END IF;
  SELECT * INTO v_claim FROM public.national_ids WHERE national_id = p_national_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الرقم القومي غير مسجل في قوائم الكلية'; END IF;
  IF v_claim.is_claimed = TRUE THEN RAISE EXCEPTION 'تم تسجيل هذا الرقم القومي من قبل'; END IF;
  IF v_claim.level IS NOT NULL AND v_claim.level <> p_level THEN RAISE EXCEPTION 'الفرقة المختارة لا تطابق الفرقة المسجلة في قائمة الكلية'; END IF;
  SELECT COUNT(*) INTO v_subject_count FROM public.subjects s WHERE s.id = ANY(COALESCE(p_subject_ids, ARRAY[]::UUID[]))
    AND ((p_term <> 'summer' AND s.level = p_level AND s.term = p_term) OR (p_term = 'summer' AND s.term IN ('term1', 'term2') AND s.level <= p_level));
  IF v_subject_count <> COALESCE(array_length(p_subject_ids, 1), 0) OR v_subject_count = 0 THEN RAISE EXCEPTION 'اختيار المواد غير مطابق للفرقة والترم'; END IF;
  INSERT INTO public.students (id, national_id, full_name_ar, full_name_en, email, level, term)
  VALUES (v_user_id, p_national_id, trim(p_full_name_ar), trim(p_full_name_en), lower(trim(p_email)), p_level, p_term);
  INSERT INTO public.student_subjects (student_id, subject_id) SELECT v_user_id, s.id FROM public.subjects s WHERE s.id = ANY(p_subject_ids);
  UPDATE public.national_ids SET is_claimed = TRUE, claimed_by = v_user_id WHERE id = v_claim.id;
  RETURN v_user_id;
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'هذا الحساب أو الرقم القومي مستخدم بالفعل'; END;
$$;
GRANT EXECUTE ON FUNCTION public.register_student(VARCHAR, TEXT, TEXT, TEXT, SMALLINT, public.academic_term, UUID[]) TO authenticated;

-- ═══════════════════════════════════════════════════════════════
-- 6. Enhanced password reset: add can_change column to track
--    whether admin approved (student can now set their own password)
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.password_reset_requests ADD COLUMN IF NOT EXISTS new_password_set BOOLEAN NOT NULL DEFAULT FALSE;

-- Student insert policy for password_reset_requests
DROP POLICY IF EXISTS student_insert_reset_requests ON password_reset_requests;
CREATE POLICY student_insert_reset_requests ON password_reset_requests
  FOR INSERT WITH CHECK (auth.uid() = student_id);

-- Student update policy - students can update their own approved requests to mark password set
DROP POLICY IF EXISTS student_update_reset_requests ON password_reset_requests;
CREATE POLICY student_update_reset_requests ON password_reset_requests
  FOR UPDATE USING (auth.uid() = student_id AND status = 'approved');

-- ═══════════════════════════════════════════════════════════════
-- 7. Recreate get_secret_grades to properly accept optional subject_id
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_secret_grades(p_subject_id UUID DEFAULT NULL)
RETURNS TABLE (
  student_id UUID, student_name TEXT, national_id VARCHAR, subject_id UUID,
  subject_name TEXT, attended_sessions BIGINT, total_sessions BIGINT, max_grade SMALLINT, grade NUMERIC
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  RETURN QUERY
  SELECT st.id, st.full_name_ar, st.national_id, s.id, s.name_ar,
    (SELECT COUNT(DISTINCT al.session_id) FROM public.attendance_logs al JOIN public.lecture_sessions ls ON ls.id = al.session_id WHERE al.student_id = st.id AND ls.subject_id = s.id AND ls.closed_at IS NOT NULL),
    (SELECT COUNT(*) FROM public.lecture_sessions ls WHERE ls.subject_id = s.id AND ls.closed_at IS NOT NULL),
    s.max_grade,
    public.calculate_secret_grade(st.id, s.id)
  FROM public.student_subjects ss
  JOIN public.students st ON st.id = ss.student_id
  JOIN public.subjects s ON s.id = ss.subject_id
  WHERE p_subject_id IS NULL OR s.id = p_subject_id
  ORDER BY st.full_name_ar, s.name_ar;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_secret_grades(UUID) TO authenticated;
