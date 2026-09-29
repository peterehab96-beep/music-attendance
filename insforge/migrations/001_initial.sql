-- نظام حضور التربية الموسيقية — المخطط الأولي الآمن
-- يُنفّذ على PostgreSQL الخاص بمشروع InsForge.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE public.student_status AS ENUM ('pending', 'approved', 'rejected', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.academic_term AS ENUM ('term1', 'term2', 'summer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.admins (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.national_ids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  national_id VARCHAR(14) UNIQUE NOT NULL CHECK (national_id ~ '^[0-9]{14}$'),
  full_name_reference TEXT,
  is_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  claimed_by UUID,
  uploaded_by UUID REFERENCES public.admins(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_national_ids_id ON public.national_ids(national_id);

CREATE TABLE IF NOT EXISTS public.students (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  national_id VARCHAR(14) UNIQUE NOT NULL REFERENCES public.national_ids(national_id),
  full_name_ar TEXT NOT NULL,
  full_name_en TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  level SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 4),
  term public.academic_term NOT NULL,
  status public.student_status NOT NULL DEFAULT 'pending',
  password_reset_requests_used SMALLINT NOT NULL DEFAULT 0 CHECK (password_reset_requests_used BETWEEN 0 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES public.admins(id)
);
DO $$ BEGIN
  ALTER TABLE public.national_ids ADD CONSTRAINT national_ids_claimed_by_fk FOREIGN KEY (claimed_by) REFERENCES public.students(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar TEXT UNIQUE NOT NULL,
  level SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 4),
  term public.academic_term NOT NULL,
  max_grade SMALLINT NOT NULL CHECK (max_grade IN (20, 40))
);

CREATE TABLE IF NOT EXISTS public.student_subjects (
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (student_id, subject_id)
);

CREATE TABLE IF NOT EXISTS public.webauthn_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  credential_id TEXT UNIQUE NOT NULL,
  public_key BYTEA NOT NULL,
  sign_count BIGINT NOT NULL DEFAULT 0,
  device_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.webauthn_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  flow TEXT NOT NULL CHECK (flow IN ('registration', 'authentication')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user_flow ON public.webauthn_challenges(user_id, flow, created_at DESC);

CREATE TABLE IF NOT EXISTS public.geofence_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL DEFAULT 'الزقازيق القبلية، قسم أول الزقازيق، محافظة الشرقية 7133321',
  latitude DOUBLE PRECISION NOT NULL DEFAULT 30.58782239324016 CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL DEFAULT 31.514812503965796 CHECK (longitude BETWEEN -180 AND 180),
  radius_meters INTEGER NOT NULL DEFAULT 500 CHECK (radius_meters BETWEEN 50 AND 1000),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID REFERENCES public.admins(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.lecture_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES public.subjects(id),
  opened_by UUID NOT NULL REFERENCES public.admins(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT lecture_sessions_active_closed_check CHECK (is_active OR closed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON public.lecture_sessions(subject_id, is_active);

CREATE TABLE IF NOT EXISTS public.attendance_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.lecture_sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  distance_meters DOUBLE PRECISION NOT NULL CHECK (distance_meters >= 0),
  webauthn_credential_id TEXT NOT NULL,
  UNIQUE (session_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_attendance_student ON public.attendance_logs(student_id, checked_in_at DESC);

CREATE TABLE IF NOT EXISTS public.admin_google_tokens (
  admin_id UUID PRIMARY KEY REFERENCES public.admins(id) ON DELETE CASCADE,
  access_token_encrypted BYTEA NOT NULL,
  refresh_token_encrypted BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES auth.users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.is_admin(p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.admins WHERE id = p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.validate_national_id(p_national_id VARCHAR(14))
RETURNS TABLE (is_available BOOLEAN, full_name_reference TEXT, reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  SELECT
    (n.id IS NOT NULL AND NOT n.is_claimed),
    n.full_name_reference,
    CASE
      WHEN n.id IS NULL THEN 'not_found'
      WHEN n.is_claimed THEN 'claimed'
      ELSE 'available'
    END
  FROM (SELECT 1) AS one
  LEFT JOIN public.national_ids n ON n.national_id = p_national_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.import_national_ids(p_admin_id UUID, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row JSONB;
  v_id TEXT;
  v_count INTEGER := 0;
BEGIN
  IF NOT public.is_admin(p_admin_id) THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    v_id := regexp_replace(COALESCE(v_row->>'national_id', ''), '\\D', '', 'g');
    IF v_id ~ '^[0-9]{14}$' THEN
      INSERT INTO public.national_ids (national_id, full_name_reference, uploaded_by)
      VALUES (v_id, NULLIF(trim(v_row->>'full_name_reference'), ''), p_admin_id)
      ON CONFLICT (national_id) DO UPDATE
        SET full_name_reference = COALESCE(EXCLUDED.full_name_reference, public.national_ids.full_name_reference), uploaded_by = p_admin_id
        WHERE public.national_ids.is_claimed = FALSE;
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.register_student(
  p_national_id VARCHAR(14),
  p_email TEXT,
  p_full_name_ar TEXT,
  p_full_name_en TEXT,
  p_level SMALLINT,
  p_term public.academic_term,
  p_subject_ids UUID[]
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_claim public.national_ids%ROWTYPE;
  v_subject_count INTEGER;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول قبل إكمال التسجيل'; END IF;
  IF p_level NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'الفرقة الدراسية غير صحيحة'; END IF;
  IF p_national_id !~ '^[0-9]{14}$' THEN RAISE EXCEPTION 'الرقم القومي يجب أن يتكون من 14 رقمًا'; END IF;
  IF length(trim(p_full_name_ar)) < 3 OR length(trim(p_full_name_en)) < 3 THEN RAISE EXCEPTION 'الاسم غير مكتمل'; END IF;

  SELECT * INTO v_claim FROM public.national_ids WHERE national_id = p_national_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الرقم القومي غير مسجل في قوائم الكلية'; END IF;
  IF v_claim.is_claimed THEN RAISE EXCEPTION 'تم تسجيل هذا الرقم القومي من قبل'; END IF;

  SELECT COUNT(*) INTO v_subject_count
  FROM public.subjects s
  WHERE s.id = ANY(COALESCE(p_subject_ids, ARRAY[]::UUID[]))
    AND ((p_term <> 'summer' AND s.level = p_level AND s.term = p_term)
      OR (p_term = 'summer' AND s.term IN ('term1', 'term2') AND s.level <= p_level));
  IF v_subject_count <> COALESCE(array_length(p_subject_ids, 1), 0) OR v_subject_count = 0 THEN
    RAISE EXCEPTION 'اختيار المواد غير مطابق للفرقة والترم';
  END IF;

  INSERT INTO public.students (id, national_id, full_name_ar, full_name_en, email, level, term)
  VALUES (v_user_id, p_national_id, trim(p_full_name_ar), trim(p_full_name_en), lower(trim(p_email)), p_level, p_term);
  INSERT INTO public.student_subjects (student_id, subject_id)
  SELECT v_user_id, s.id FROM public.subjects s WHERE s.id = ANY(p_subject_ids);
  UPDATE public.national_ids SET is_claimed = TRUE, claimed_by = v_user_id WHERE id = v_claim.id;
  RETURN v_user_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'هذا الحساب أو الرقم القومي مستخدم بالفعل';
END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_secret_grade(p_student_id UUID, p_subject_id UUID)
RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_total INTEGER;
  v_attended INTEGER;
  v_max NUMERIC;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  SELECT COUNT(*) INTO v_total FROM public.lecture_sessions WHERE subject_id = p_subject_id AND closed_at IS NOT NULL;
  SELECT COUNT(DISTINCT al.session_id) INTO v_attended
  FROM public.attendance_logs al JOIN public.lecture_sessions ls ON ls.id = al.session_id
  WHERE al.student_id = p_student_id AND ls.subject_id = p_subject_id AND ls.closed_at IS NOT NULL;
  SELECT max_grade INTO v_max FROM public.subjects WHERE id = p_subject_id;
  IF v_total = 0 THEN RETURN 0; END IF;
  RETURN ROUND((v_attended::NUMERIC / v_total) * v_max, 2);
END;
$$;

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

CREATE OR REPLACE FUNCTION public.get_active_geofence()
RETURNS TABLE (id UUID, label TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, radius_meters INTEGER)
LANGUAGE SQL SECURITY DEFINER SET search_path = public AS $$
  SELECT g.id, g.label, g.latitude, g.longitude, g.radius_meters
  FROM public.geofence_config g WHERE g.is_active = TRUE LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.record_attendance(
  p_session_id UUID, p_student_id UUID, p_latitude DOUBLE PRECISION, p_longitude DOUBLE PRECISION,
  p_distance_meters DOUBLE PRECISION, p_webauthn_credential_id TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_student_id THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.students WHERE id = p_student_id AND status = 'approved') THEN RAISE EXCEPTION 'الحساب غير معتمد'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lecture_sessions WHERE id = p_session_id AND is_active = TRUE) THEN RAISE EXCEPTION 'لا توجد محاضرة نشطة'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.student_subjects ss JOIN public.lecture_sessions ls ON ls.subject_id = ss.subject_id WHERE ss.student_id = p_student_id AND ls.id = p_session_id) THEN RAISE EXCEPTION 'المادة غير مسجلة للطالب'; END IF;
  INSERT INTO public.attendance_logs (session_id, student_id, latitude, longitude, distance_meters, webauthn_credential_id)
  VALUES (p_session_id, p_student_id, p_latitude, p_longitude, p_distance_meters, p_webauthn_credential_id)
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'تم تسجيل حضورك بالفعل لهذه المحاضرة';
END;
$$;

CREATE OR REPLACE FUNCTION public.store_google_tokens(
  p_admin_id UUID, p_access_token_hex TEXT, p_refresh_token_hex TEXT, p_expires_at TIMESTAMPTZ
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin(p_admin_id) THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  INSERT INTO public.admin_google_tokens (admin_id, access_token_encrypted, refresh_token_encrypted, expires_at)
  VALUES (p_admin_id, decode(regexp_replace(p_access_token_hex, '^\\x', ''), 'hex'), decode(regexp_replace(p_refresh_token_hex, '^\\x', ''), 'hex'), p_expires_at)
  ON CONFLICT (admin_id) DO UPDATE SET access_token_encrypted = EXCLUDED.access_token_encrypted, refresh_token_encrypted = EXCLUDED.refresh_token_encrypted, expires_at = EXCLUDED.expires_at, updated_at = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION public.get_google_tokens(p_admin_id UUID)
RETURNS TABLE (access_token_hex TEXT, refresh_token_hex TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin(p_admin_id) THEN RAISE EXCEPTION 'غير مصرح'; END IF;
  RETURN QUERY SELECT encode(t.access_token_encrypted, 'hex'), encode(t.refresh_token_encrypted, 'hex'), t.expires_at FROM public.admin_google_tokens t WHERE t.admin_id = p_admin_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_logs(actor_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), TG_OP, TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), jsonb_build_object('table', TG_TABLE_NAME));
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS audit_students ON public.students;
CREATE TRIGGER audit_students AFTER INSERT OR UPDATE OR DELETE ON public.students FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();
DROP TRIGGER IF EXISTS audit_sessions ON public.lecture_sessions;
CREATE TRIGGER audit_sessions AFTER INSERT OR UPDATE OR DELETE ON public.lecture_sessions FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();
DROP TRIGGER IF EXISTS audit_geofence ON public.geofence_config;
CREATE TRIGGER audit_geofence AFTER INSERT OR UPDATE OR DELETE ON public.geofence_config FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.national_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geofence_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lecture_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_google_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admins_self_or_admin ON public.admins;
CREATE POLICY admins_self_or_admin ON public.admins FOR SELECT USING (auth.uid() = id OR public.is_admin());
DROP POLICY IF EXISTS national_ids_admin_only ON public.national_ids;
CREATE POLICY national_ids_admin_only ON public.national_ids FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS students_self_or_admin_select ON public.students;
CREATE POLICY students_self_or_admin_select ON public.students FOR SELECT USING (auth.uid() = id OR public.is_admin());
DROP POLICY IF EXISTS students_self_or_admin_update ON public.students;
CREATE POLICY students_self_or_admin_update ON public.students FOR UPDATE USING (auth.uid() = id OR public.is_admin()) WITH CHECK (auth.uid() = id OR public.is_admin());
DROP POLICY IF EXISTS subjects_public_read ON public.subjects;
CREATE POLICY subjects_public_read ON public.subjects FOR SELECT USING (TRUE);
DROP POLICY IF EXISTS student_subjects_self_or_admin ON public.student_subjects;
CREATE POLICY student_subjects_self_or_admin ON public.student_subjects FOR SELECT USING (auth.uid() = student_id OR public.is_admin());
DROP POLICY IF EXISTS webauthn_self_or_admin ON public.webauthn_credentials;
CREATE POLICY webauthn_self_or_admin ON public.webauthn_credentials FOR SELECT USING (auth.uid() = student_id OR public.is_admin());
DROP POLICY IF EXISTS webauthn_self_insert ON public.webauthn_credentials;
CREATE POLICY webauthn_self_insert ON public.webauthn_credentials FOR INSERT WITH CHECK (auth.uid() = student_id);
DROP POLICY IF EXISTS webauthn_self_update ON public.webauthn_credentials;
CREATE POLICY webauthn_self_update ON public.webauthn_credentials FOR UPDATE USING (auth.uid() = student_id OR public.is_admin()) WITH CHECK (auth.uid() = student_id OR public.is_admin());
DROP POLICY IF EXISTS webauthn_self_delete ON public.webauthn_credentials;
CREATE POLICY webauthn_self_delete ON public.webauthn_credentials FOR DELETE USING (auth.uid() = student_id OR public.is_admin());
DROP POLICY IF EXISTS webauthn_challenges_admin_only ON public.webauthn_challenges;
CREATE POLICY webauthn_challenges_admin_only ON public.webauthn_challenges FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS webauthn_challenges_self ON public.webauthn_challenges;
CREATE POLICY webauthn_challenges_self ON public.webauthn_challenges FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS geofence_admin_only ON public.geofence_config;
CREATE POLICY geofence_admin_only ON public.geofence_config FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS sessions_student_read_admin_all ON public.lecture_sessions;
CREATE POLICY sessions_student_read_admin_all ON public.lecture_sessions FOR SELECT USING (public.is_admin() OR (is_active AND EXISTS (SELECT 1 FROM public.students st WHERE st.id = auth.uid() AND st.status = 'approved')));
DROP POLICY IF EXISTS sessions_admin_write ON public.lecture_sessions;
CREATE POLICY sessions_admin_write ON public.lecture_sessions FOR INSERT WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS sessions_admin_update ON public.lecture_sessions;
CREATE POLICY sessions_admin_update ON public.lecture_sessions FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS attendance_self_or_admin ON public.attendance_logs;
CREATE POLICY attendance_self_or_admin ON public.attendance_logs FOR SELECT USING (auth.uid() = student_id OR public.is_admin());
DROP POLICY IF EXISTS google_tokens_admin_only ON public.admin_google_tokens;
CREATE POLICY google_tokens_admin_only ON public.admin_google_tokens FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS audit_admin_only ON public.audit_logs;
CREATE POLICY audit_admin_only ON public.audit_logs FOR SELECT USING (public.is_admin());

GRANT EXECUTE ON FUNCTION public.validate_national_id(VARCHAR) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_national_ids(UUID, JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_geofence() TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_attendance(UUID, UUID, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.store_google_tokens(UUID, TEXT, TEXT, TIMESTAMPTZ) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_google_tokens(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_student(VARCHAR, TEXT, TEXT, TEXT, SMALLINT, public.academic_term, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_secret_grades(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_secret_grade(UUID, UUID) TO authenticated;

INSERT INTO public.geofence_config (label, latitude, longitude, radius_meters, is_active)
SELECT 'الزقازيق القبلية، قسم أول الزقازيق، محافظة الشرقية 7133321', 30.58782239324016, 31.514812503965796, 500, TRUE
WHERE NOT EXISTS (SELECT 1 FROM public.geofence_config);

INSERT INTO public.subjects (name_ar, level, term, max_grade) VALUES
  ('قواعد وصولفيج غربى 1', 1, 'term1', 20),
  ('قواعد وصولفيج غربى 2', 1, 'term2', 20),
  ('إيقاع حركي 1', 1, 'term2', 40),
  ('صولفيج غربي 3', 2, 'term1', 20),
  ('إيقاع حركي 2', 2, 'term1', 40),
  ('قواعد وصولفيج غربى 4', 2, 'term2', 20),
  ('صولفيج غربي 5', 3, 'term1', 20),
  ('ارتجال 1', 3, 'term2', 40),
  ('صولفيج غربي 6', 4, 'term1', 20),
  ('ارتجال 2', 4, 'term2', 40)
ON CONFLICT (name_ar) DO NOTHING;
