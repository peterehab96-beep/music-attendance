-- 023_admin_set_student_password.sql
-- آلية كلمات المرور للطلاب النسّائيين:
-- الإدمن يضغط «تعيين كلمة مرور» في صفحة الطالب → يولّد النظام كلمة مرور صريحة
-- مرة واحدة ويعرضها للإدمن ليمليها على الطالب (مثلًا بالهاتف). الكلمة لا تُخزَّن
-- في أي جدول؛ يُخزَّن bcrypt hash فقط في auth.users، ويعود النص الصريح في
-- استجابة الاستدعاء فقط ولا يظهر مرة أخرى أبدًا.
-- الحماية:
--   * الدالة SECURITY DEFINER ومحمية بـ is_admin().
--   * تُلغي كل طلبات إعادة التعيين المعلقة للطالب.
--   * تسجل في audit_logs دون كتابة الكلمة الصريحة (hash فقط).
--   * صلاحية التنفيذ لـ authenticated فقط (باستدعاء POSTgREST من الواجهة
--     بجلسة الإدمن). لا يملك anon أي صلاحية عليها.

CREATE OR REPLACE FUNCTION public.admin_set_student_password(
  p_student_id UUID,
  p_new_password TEXT DEFAULT NULL
)
RETURNS TABLE (generated_password TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_password TEXT;
  v_email TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'غير مصرح';
  END IF;

  SELECT email INTO v_email FROM public.students WHERE id = p_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الطالب غير موجود';
  END IF;

  IF p_new_password IS NOT NULL AND length(trim(p_new_password)) > 0 THEN
    v_password := trim(p_new_password);
  ELSE
    -- كلمة مرور مقروءة وقابلة للإملاء بالصوت: 2 مقطع + 2 رقم + رمز.
    -- أحرف واضحة فقط (بدون O/l/I/1/0/5/S/Z/2 الملبكة).
    v_password := (
      SELECT string_agg(seg, '')
      FROM (
        SELECT substring('bcdfghjklmnpqrstvwxz' FROM floor(random() * 20 + 1)::int FOR 1) AS seg
        UNION ALL SELECT substring('aeiou' FROM floor(random() * 5 + 1)::int FOR 1)
        UNION ALL SELECT substring('bcdfghjklmnpqrstvwxz' FROM floor(random() * 20 + 1)::int FOR 1)
        UNION ALL SELECT substring('aeiou' FROM floor(random() * 5 + 1)::int FOR 1)
        UNION ALL SELECT substring('34678' FROM floor(random() * 5 + 1)::int FOR 1)
        UNION ALL SELECT substring('34678' FROM floor(random() * 5 + 1)::int FOR 1)
        UNION ALL SELECT substring('@#&' FROM floor(random() * 3 + 1)::int FOR 1)
        UNION ALL SELECT substring('abcdefghjkmnpqrstuvwxyz' FROM floor(random() * 23 + 1)::int FOR 1)
      ) syllables
    );
  END IF;

  IF length(v_password) < 8 THEN
    RAISE EXCEPTION 'كلمة المرور غير مستوفية للشروط';
  END IF;
  IF NOT (v_password ~ '[a-z]' AND v_password ~ '[0-9]') THEN
    RAISE EXCEPTION 'كلمة المرور ضعيفة';
  END IF;

  UPDATE auth.users
     SET password = crypt(v_password, gen_salt('bf', 10)), updated_at = now()
   WHERE id = p_student_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'حساب المصادقة للطالب غير موجود';
  END IF;

  -- إلغاء أي طلبات إعادة تعيين معلقة لهذا الطالب؛ الكلمة الجديدة تجاوزتها.
  UPDATE public.password_reset_requests
     SET status = 'rejected', handled_at = now()
   WHERE student_id = p_student_id AND status = 'pending';

  INSERT INTO public.audit_logs (action, entity_type, entity_id, actor_id, metadata)
  VALUES (
    'admin_set_student_password',
    'students',
    p_student_id,
    auth.uid(),
    jsonb_build_object('password_hash', crypt(v_password, gen_salt('bf', 4)), 'note',
      'الإدمن أعاد تعيين كلمة مرور الطالب. النص الصريح غير مخزَّن.')
  );

  RETURN QUERY SELECT v_password;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_student_password(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_set_student_password(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_student_password(UUID, TEXT) FROM anon;
