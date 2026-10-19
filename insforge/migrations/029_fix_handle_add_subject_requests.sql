-- ══════════════════════════════════════════════════════════════════════
-- 029_fix_handle_add_subject_requests.sql
-- عيب فعلي اكتشفه الاختبار الحي: زر «موافقة» في صفحة «طلبات إضافة المواد»
-- يفشل دائمًا بـ:
--   400 / 42P10 "there is no unique or exclusion constraint matching the
--                 ON CONFLICT specification"
-- السبب: جدول public.student_subjects لم يعد له مفتاح مركّب (student_id,
-- subject_id) — المفتاح هو id الآن، والوجودية الوحيدة هي فهرس جزئي فريد
-- idx_active_enrollment على (student_id, subject_id) WHERE status IN
-- ('active','parallel')، فلا يقبل ON CONFLICT (student_id, subject_id).
-- الحل: منطق إدراج/تحديث صريح بدل ON CONFLICT — نفس النتيجة تمامًا:
--   • صف نشط/موازيع موجود ← لا شيء (الطالب مسجّل أصلًا).
--   • صف قديم بحالة أخرى ← تنشيطه.
--   • لا صف ← إدراج صف نشط جديد.
-- ══════════════════════════════════════════════════════════════════════

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
      IF EXISTS (
        SELECT 1 FROM public.student_subjects ss
        WHERE ss.student_id = r.student_id AND ss.subject_id = r.subject_id
          AND ss.status IN ('active', 'parallel')
      ) THEN
        NULL; -- مسجّل فعليًا بالفعل — لا إدراج مكرر
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
           handled_by_role = CASE WHEN public.is_super_admin()
                                  THEN 'super'::public.subject_admin_role
                                  ELSE 'subject'::public.subject_admin_role END
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
