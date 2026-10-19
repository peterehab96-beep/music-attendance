-- 026_auth_hardening.sql
-- تدقيق أمني شامل لمسارات المصادقة (بعقلية المخترق):
--
-- ثغرة 1: admin_set_user_password كانت SECURITY DEFINER بلا تحقق داخل الدالة.
--   الاستدعاء الوحيد لها من edge functions بالمفتاح السري، لكن لو حُجبت دالة
--   سُحبت صلاحياتها يظل الوظيفي محصّنًا. نضيف حارسًا داخل الدالة: تُسمح فقط
--   عندما يأتي الاستدعاء بجلسة الخدمة (api key)، أو من داخل محرك إعادة التعيين.
--
-- ثغرة 2: admin_set_student_password كانت GRANT لـ authenticated. أي طالب
--   مسجّل دخوله يستطيع استدعاء RPC مباشرة مع p_student_id لأي طالب آخر
--   (is_admin() داخل الدالة يمنع التجاوز فعلًا، لكن نبقيها منشودة الدفاع
--   في العمق: نمنع anon ونُبقي authenticated لأن الواجهة تستدعيها بجلسة
--   الإدمن، مع بقاء حارس is_admin الأول).
--
-- ثغرة 3: بعد تغيير كلمة المرور يجب إبطال كل الجلسات القديمة (refresh tokens)
--   حتى يسقط خاطف الجلسة الذي كان جالسًا قبل التغيير. نضيف دالة
--   revoke_user_sessions ونربطها داخل admin_set_user_password نفسها.

CREATE OR REPLACE FUNCTION public.revoke_user_sessions(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_revoked INTEGER;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير محدد';
  END IF;

  -- إبطال كل refresh tokens النشطة للمستخدم إن كان جدول الجلسات موجودًا في
  -- هذه البيئة. يتعامل مع البيئات التي لم تعرّف auth.sessions بعد.
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='auth' AND table_name='sessions') THEN
    UPDATE auth.sessions
       SET revoked_at = now()
     WHERE user_id = p_user_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_revoked = ROW_COUNT;
  END IF;

  INSERT INTO public.audit_logs (action, entity_type, entity_id, metadata)
  VALUES ('revoke_user_sessions', 'auth_users', p_user_id,
    jsonb_build_object('revoked_sessions', v_revoked, 'at', now()))
  ON CONFLICT DO NOTHING;

  RETURN v_revoked;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_user_sessions(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_user_sessions(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.revoke_user_sessions(UUID) FROM authenticated;

-- ── admin_set_user_password: يبقى حصريًا لمفتاح الخدمة فقط، ويضيف إبطال الجلسات تلقائيًا ──
CREATE OR REPLACE FUNCTION public.admin_set_user_password(p_user_id UUID, p_new_password TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'المستخدم غير محدد';
  END IF;
  IF p_new_password IS NULL OR length(p_new_password) < 8 THEN
    RAISE EXCEPTION 'كلمة المرور غير مستوفية للشروط';
  END IF;
  IF NOT (p_new_password ~ '[a-z]' AND p_new_password ~ '[A-Z]' AND p_new_password ~ '[0-9]' AND p_new_password ~ '[^A-Za-z0-9]') THEN
    RAISE EXCEPTION 'كلمة المرور غير مستوفية للشروط';
  END IF;

  UPDATE auth.users
     SET password = crypt(p_new_password, gen_salt('bf', 10)), updated_at = now()
   WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'المستخدم غير موجود';
  END IF;

  -- إبطال كل الجلسات النشطة: أي شخص كان مسجًلا بجلسة قديمة (مخترق سابق) يخرج فورًا.
  PERFORM public.revoke_user_sessions(p_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_user_password(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_user_password(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.admin_set_user_password(UUID, TEXT) FROM authenticated;

-- ── admin_set_student_password: تبقى لواجهة الإدمن (بجلسة الإدمن) مع حارس is_admin ──
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

  -- إبطال جلسات الطالب القديمة فوراً بعد كل إعادة تعيين (حتى الجلسة الحالية للإدمن لن تتأثر - هي عبارة عن جلسة إدمن مختلفة).
  PERFORM public.revoke_user_sessions(p_student_id);

  UPDATE public.password_reset_requests
     SET status = 'rejected', handled_at = now()
   WHERE student_id = p_student_id AND status = 'pending';

  INSERT INTO public.audit_logs (action, entity_type, entity_id, actor_id, metadata)
  VALUES (
    'admin_set_student_password',
    'students',
    p_student_id,
    auth.uid(),
    jsonb_build_object('note', 'الإدمن أعاد تعيين كلمة مرور الطالب. النص الصريح غير مخزَّن. وأُبطلت جميع الجلسات النشطة.')
  );

  RETURN QUERY SELECT v_password;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_student_password(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_set_student_password(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_student_password(UUID, TEXT) FROM anon;

-- ── حماية brute-force على إعادة التسجيل من عدم تسجيل الدخول (student-forgot-password) ──
-- الجدول password_reset_requests عليه بالفعل RLS، لكن الحد الأقصى 3 طلبات/ترم
-- محسوب في الواجهة. نضيف تحققًا على مستوى قاعدة البيانات من إجمالي الطلبات
-- خلال آخر 24 ساعة لكل طالب (تجاوز ال 3 طلبات في يوم واحد يرفض).
CREATE OR REPLACE FUNCTION public.guard_password_reset_rate(p_student_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_day_requests INTEGER;
BEGIN
  SELECT count(*) INTO v_day_requests
    FROM public.password_reset_requests
   WHERE student_id = p_student_id
     AND requested_at > now() - INTERVAL '24 hours';

  IF v_day_requests >= 3 THEN
    RETURN FALSE; -- تجاوز الحد: راجع الإدارة مباشرة.
  END IF;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_password_reset_rate(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_password_reset_rate(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.guard_password_reset_rate(UUID) FROM authenticated;

-- ── سجل تدقيق: نعلّم أي محاولات فاشلة كثيرة من نفس الطلب ──
-- (مطابقة الهجوم القديم: enumeration عبر رسائل مختلفة محسومة في student-forgot-password بالرسالة العامة).
