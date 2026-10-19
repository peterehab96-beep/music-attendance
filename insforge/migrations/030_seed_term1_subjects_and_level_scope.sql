-- ══════════════════════════════════════════════════════════════════════
-- 030_seed_term1_subjects_and_level_scope.sql
--
-- 1) إكمال كتالوج مواد الترم الأول لكل مستوى وفق النموذج الرسمي لتسجيل
--    مقررات التربية الموسيقية (المستويات 1–4)، مع درجات أعمال السنة التي
--    زوّدنا بها الإدارة. القاعدة كانت تحتوي 10 مواد فقط، فمعظم المواد
--    الرسمية غير موجودة أصلًا فلا يستطيع الطالب اختيارها.
--    • أسماء مُنقّحة مطابقة لأسلوب القاعدة القائم (بدون أقواس في الأرقام).
--    • المواد الموجودة فعلًا تُستثنى تلقائيًا (ON CONFLICT DO NOTHING):
--        قواعد وصولفيج غربى 1 (20) · صولفيج غربي 3 (20) · إيقاع حركي 2 (40) ·
--        صولفيج غربي 5 (20) · صولفيج غربي 6 (20)
--    • القيم غير المذكورة صراحة في جدول الإدارة (مواد التعليم/النظرية)
--      = 20 درجة. تدريب ميداني 1 و3 بلا درجة ثابتة في الجدول الأصلي
--      («وفقًا لنموذج توزيع درجات المقرر») → أُدرجت بـ20 ويمكن تعديل
--      أعمال السنة لكل طالب يدويًا من سجل الدرجات السري.
--
-- 2) حصر «إضافة مواد» بمواد فرقة الطالب فقط: طالب الفرقة الأولى لا تظهر له
--    مواد الفرقة الثانية ولا أي مستوى آخر — بنفس قاعدة النموذج الرسمي.
-- ══════════════════════════════════════════════════════════════════════

-- ── المستوى الأول — الترم الأول ──
INSERT INTO public.subjects (name_ar, level, term, max_grade) VALUES
  ('قواعد وصولفيج عربي 1', 1, 'term1', 20),
  ('آلة أساسية بيانو 1', 1, 'term1', 40),
  ('آلة تخصص / غناء 1', 1, 'term1', 40),
  ('تاريخ وتذوق الموسيقى العالمية', 1, 'term1', 40),
  ('آلة تربوية (ريكورد)', 1, 'term1', 40),
  ('عروض شعرية وموسيقية', 1, 'term1', 20)
ON CONFLICT (name_ar) DO NOTHING;

-- ── المستوى الثاني — الترم الأول ──
INSERT INTO public.subjects (name_ar, level, term, max_grade) VALUES
  ('قواعد وصولفيج عربي 2', 2, 'term1', 20),
  ('آلة أساسية بيانو 3', 2, 'term1', 40),
  ('آلة تخصص / غناء 3', 2, 'term1', 40),
  ('هارموني 1', 2, 'term1', 20),
  ('تاريخ وتذوق الموسيقى العربية', 2, 'term1', 40),
  ('مهارات أساسية في تعلم اللغة العربية', 2, 'term1', 20),
  ('علم نفس النمو', 2, 'term1', 20),
  ('تاريخ التربية ونظام التعليم في مصر', 2, 'term1', 20),
  ('مهارات التدريس المصغر', 2, 'term1', 20),
  ('استخدام الحاسب الآلي في التخصص', 2, 'term1', 20)
ON CONFLICT (name_ar) DO NOTHING;

-- ── المستوى الثالث — الترم الأول ──
INSERT INTO public.subjects (name_ar, level, term, max_grade) VALUES
  ('آلة أساسية بيانو 5', 3, 'term1', 40),
  ('آلة تخصص / غناء 5', 3, 'term1', 40),
  ('غناء جماعي', 3, 'term1', 40),
  ('تاريخ وتحليل الموسيقى العالمية 1', 3, 'term1', 40),
  ('صولفيج وغناء عربي 2', 3, 'term1', 20),
  ('تدريب ميداني 1', 3, 'term1', 20),
  ('تكنولوجيا التعليم', 3, 'term1', 20),
  ('مهارات توظيف اللغة الإنجليزية في مجال التخصص', 3, 'term1', 20),
  ('الأصول الاجتماعية والثقافية للتربية', 3, 'term1', 20),
  ('طرق واستراتيجيات التدريس في التخصص', 3, 'term1', 20)
ON CONFLICT (name_ar) DO NOTHING;

-- ── المستوى الرابع — الترم الأول ──
INSERT INTO public.subjects (name_ar, level, term, max_grade) VALUES
  ('آلة أساسية بيانو 7', 4, 'term1', 40),
  ('آلة تخصص / غناء 7', 4, 'term1', 40),
  ('هارموني وكونتربوينت 4', 4, 'term1', 20),
  ('تاريخ وتحليل الموسيقى العربية 2', 4, 'term1', 40),
  ('صولفيج وغناء عربي 3', 4, 'term1', 20),
  ('تدريب ميداني 3', 4, 'term1', 20),
  ('مشروع تخرج 1', 4, 'term1', 20),
  ('التربية المقارنة والإدارة التعليمية', 4, 'term1', 20),
  ('علم نفس تعليمي (قدرات عقلية)', 4, 'term1', 20),
  ('الجودة وتطبيقاتها في المؤسسات التعليمية', 4, 'term1', 20)
ON CONFLICT (name_ar) DO NOTHING;

-- مواءمة المواد الموجودة فعلًا مع جدول درجات الإدارة (لا يتغيّر شيء إن كانت القيم مطابقة أصلًا):
UPDATE public.subjects SET max_grade = 20 WHERE name_ar IN
  ('قواعد وصولفيج غربى 1', 'صولفيج غربي 3', 'صولفيج غربي 5', 'صولفيج غربي 6')
  AND max_grade <> 20;
UPDATE public.subjects SET max_grade = 40 WHERE name_ar = 'إيقاع حركي 2' AND max_grade <> 40;

-- ── حصر المواد بفرقة الطالب ──
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
DECLARE
  v_student public.students%ROWTYPE;
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

  SELECT * INTO v_student FROM public.students st WHERE st.id = auth.uid();
  IF NOT FOUND AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'غير مصرح — حساب طالب فقط';
  END IF;

  -- مواد فرقة الطالب فقط: طالب الفرقة الأولى لا تظهر له مواد الفرقة الثانية.
  IF v_student.id IS NOT NULL AND p_level <> v_student.level THEN
    RAISE EXCEPTION 'هذه المواد تخص الفرقة % — اختر فرقتك (الفرقة %)',
      p_level, COALESCE(v_student.level, p_level);
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
