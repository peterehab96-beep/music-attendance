-- 010_security_hardening.sql
-- 1. منع تسريب تردد الإشارة الصوتية للطلاب عبر DevTools / PostgREST:
--    قصر صلاحية SELECT الممنوحة لـ anon و authenticated على الأعمدة الآمنة فقط،
--    وحجب عمود audio_token_frequency ليكون متاحاً فقط للأدمن ولدالة record_audio_attendance (SECURITY DEFINER).
REVOKE SELECT ON public.lecture_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, subject_id, opened_by, opened_at, closed_at, is_active, is_attendance_active) ON public.lecture_sessions TO anon, authenticated;
GRANT ALL ON public.lecture_sessions TO postgres;

-- 2. منع تسريب درجات الطلاب السرية (IDOR Vulnerability):
--    حجب صلاحية تنفيذ calculate_secret_grade عن المستخدمين العاديين،
--    بحيث لا يُستدعى إلا داخلياً عبر دالة get_secret_grades المحمية بـ is_admin().
REVOKE ALL ON FUNCTION public.calculate_secret_grade(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calculate_secret_grade(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.calculate_secret_grade(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_secret_grade(UUID, UUID) TO postgres;
