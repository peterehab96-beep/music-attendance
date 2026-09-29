-- إصلاح موثوقية قائمة الأرقام: الاحتفاظ بالمستوى، وإرجاع نتيجة حقيقية للاستيراد.
ALTER TABLE public.national_ids
  ADD COLUMN IF NOT EXISTS level SMALLINT CHECK (level BETWEEN 1 AND 4);

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
    IF v_id !~ '^[0-9]{14}$' OR (v_level IS NOT NULL AND v_level NOT BETWEEN 1 AND 4) THEN CONTINUE; END IF;
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

CREATE OR REPLACE FUNCTION public.register_student(
  p_national_id VARCHAR(14), p_email TEXT, p_full_name_ar TEXT, p_full_name_en TEXT,
  p_level SMALLINT, p_term public.academic_term, p_subject_ids UUID[]
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user_id UUID := auth.uid(); v_claim public.national_ids%ROWTYPE; v_subject_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول قبل إكمال التسجيل'; END IF;
  IF p_level NOT BETWEEN 1 AND 4 OR p_national_id !~ '^[0-9]{14}$' THEN RAISE EXCEPTION 'بيانات التسجيل غير صحيحة'; END IF;
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

GRANT EXECUTE ON FUNCTION public.import_national_ids(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_national_id(VARCHAR) TO anon, authenticated;
