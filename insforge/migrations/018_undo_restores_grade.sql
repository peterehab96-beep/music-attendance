-- 018_undo_restores_grade.sql
-- إصلاح التراجع: كان يحذف سجلات الإجراءات فقط دون استعادة الدرجات المخصومة.
-- الآن يسترد مجموع الدرجات المخصومة (deduction) ويعيدها لأعمال السنة
-- بحد أقصى الدرجة الكاملة للمادة، ثم يحذف السجلات.

CREATE OR REPLACE FUNCTION public.undo_attendance_law(p_student_id UUID, p_subject_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_refund NUMERIC;
  v_max SMALLINT;
  v_current NUMERIC;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;

  SELECT COALESCE(SUM(deducted_grade), 0)
  INTO v_refund
  FROM public.attendance_law_actions
  WHERE student_id = p_student_id AND subject_id = p_subject_id
    AND action_type = 'deduction';

  IF v_refund > 0 THEN
    SELECT s.max_grade INTO v_max FROM public.subjects s WHERE s.id = p_subject_id;
    SELECT ss.year_work_grade INTO v_current
    FROM public.student_subjects ss
    WHERE ss.student_id = p_student_id AND ss.subject_id = p_subject_id;
    UPDATE public.student_subjects
    SET year_work_grade = LEAST(COALESCE(v_current, 0) + v_refund, v_max::NUMERIC)
    WHERE student_id = p_student_id AND subject_id = p_subject_id;
  END IF;

  DELETE FROM public.attendance_law_actions
  WHERE student_id = p_student_id AND subject_id = p_subject_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.undo_attendance_law(UUID, UUID) TO authenticated;
