-- ══════════════════════════════════════════════════════════════════════
-- 028_available_subjects_rpc.sql
-- الدالة الناقصة التي تستدعيها صفحة «إضافة مواد دراسية» في لوحة الطالب:
--   database.rpc('available_subjects_for_student', { p_level, p_term })
-- بدونها كانت الصفحة تسقط بخطأ:
--   Could not find the function public.available_subjects_for_student(p_level, p_term)
-- القواعد:
--   • الطالب فقط (أو الأدمن) — ومن حساب طالب معتمد فعليًا في الجدول.
--   • ترجع مواد المستوى والترم المطلوبين فقط.
--   • تستثني المواد المسجلة فعلًا (active/parallel) حتى لا تُعرض للمعادلة.
--   • المواد المعلقة طلبها تُعرض والواجهة تعطّلها بعلامة «معلق».
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.available_subjects_for_student(
  p_level SMALLINT,
  p_term public.academic_term
)
RETURNS TABLE (
  id UUID,
  name_ar TEXT,
  level SMALLINT,
  term public.academic_term,
  max_grade SMALLINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'غير مصرح — سجّل الدخول أولًا';
  END IF;
  IF p_level IS NULL OR p_level NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'مستوى دراسي غير صحيح';
  END IF;
  IF p_term IS NULL THEN
    RAISE EXCEPTION 'ترم دراسي غير صحيح';
  END IF;
  IF NOT public.is_admin()
     AND NOT EXISTS (SELECT 1 FROM public.students st WHERE st.id = auth.uid()) THEN
    RAISE EXCEPTION 'غير مصرح — حساب طالب فقط';
  END IF;

  RETURN QUERY
  SELECT s.id, s.name_ar, s.level, s.term, s.max_grade
  FROM public.subjects s
  WHERE s.level = p_level
    AND s.term = p_term
    AND NOT EXISTS (
      SELECT 1 FROM public.student_subjects ss
      WHERE ss.student_id = auth.uid()
        AND ss.subject_id = s.id
        AND ss.status IN ('active', 'parallel')
    )
  ORDER BY s.name_ar;
END;
$$;

REVOKE ALL ON FUNCTION public.available_subjects_for_student(SMALLINT, public.academic_term) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.available_subjects_for_student(SMALLINT, public.academic_term) FROM anon;
GRANT EXECUTE ON FUNCTION public.available_subjects_for_student(SMALLINT, public.academic_term) TO authenticated;
