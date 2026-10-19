-- 021_check_in_rpc.sql
-- توحيد تدفق تسجيل الحضور بالبصمة في استدعاءين فقط بدل ~10 استعلامات متتابعة.
--
-- التصميم:
--   check_in_prepare  → يجمع كل عمليات القراءة والتحقق في طلب واحد ويعيد JSONB.
--   check_in_commit   → يكتب الحضور + يحدّث عدّاد البصمة + يحذف التحدي في عملية ذرّية واحدة.
-- التحقق التشفيري من WebAuthn يبقى في دالة Edge (لا يمكن تنفيذه في SQL).

CREATE OR REPLACE FUNCTION public.check_in_prepare(
  p_session_id UUID,
  p_credential_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_student_status public.student_status;
  v_session RECORD;
  v_enrolled BOOLEAN;
  v_geo RECORD;
  v_cred RECORD;
  v_challenge RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'unauthenticated', 'error', 'يجب تسجيل الدخول أولًا');
  END IF;

  SELECT status INTO v_student_status FROM public.students WHERE id = v_uid;
  IF v_student_status IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'no_student', 'error', 'لا يوجد ملف طالب لهذا الحساب');
  END IF;
  IF v_student_status <> 'approved' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_approved', 'error', 'لا يمكن تسجيل الحضور قبل اعتماد الحساب');
  END IF;

  SELECT id, subject_id, is_active INTO v_session
  FROM public.lecture_sessions WHERE id = p_session_id AND is_active = TRUE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'no_session', 'error', 'لا توجد محاضرة نشطة لهذه المادة');
  END IF;

  SELECT TRUE INTO v_enrolled
  FROM public.student_subjects
  WHERE student_id = v_uid AND subject_id = v_session.subject_id AND status IN ('active', 'parallel')
  LIMIT 1;
  IF v_enrolled IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_enrolled', 'error', 'هذه المادة ليست ضمن موادك المسجلة');
  END IF;

  SELECT latitude, longitude, radius_meters INTO v_geo
  FROM public.geofence_config WHERE is_active = TRUE LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'no_geofence', 'error', 'لم يتم إعداد نطاق الكلية بعد');
  END IF;

  SELECT id, encode(public_key, 'hex') AS public_key_hex, sign_count INTO v_cred
  FROM public.webauthn_credentials
  WHERE student_id = v_uid AND credential_id = p_credential_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'no_credential', 'error', 'مفتاح الجهاز غير مرتبط بهذا الحساب');
  END IF;

  SELECT id, challenge INTO v_challenge
  FROM public.webauthn_challenges
  WHERE user_id = v_uid AND flow = 'authentication' AND expires_at > NOW()
  ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'no_challenge', 'error', 'انتهت جلسة التحقق، أعد المحاولة');
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'session_id', v_session.id,
    'subject_id', v_session.subject_id,
    'geofence', jsonb_build_object('latitude', v_geo.latitude, 'longitude', v_geo.longitude, 'radius_meters', v_geo.radius_meters),
    'credential', jsonb_build_object('id', v_cred.id, 'credential_id', p_credential_id, 'public_key_hex', v_cred.public_key_hex, 'sign_count', v_cred.sign_count),
    'challenge', jsonb_build_object('id', v_challenge.id, 'value', v_challenge.challenge)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.check_in_commit(
  p_session_id UUID,
  p_latitude DOUBLE PRECISION,
  p_longitude DOUBLE PRECISION,
  p_distance_meters DOUBLE PRECISION,
  p_credential_id TEXT,
  p_credential_row_id UUID,
  p_new_sign_count BIGINT,
  p_challenge_row_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_subject_id UUID;
  v_attendance_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'unauthenticated', 'error', 'يجب تسجيل الدخول أولًا');
  END IF;

  SELECT subject_id INTO v_subject_id FROM public.lecture_sessions WHERE id = p_session_id AND is_active = TRUE;
  IF v_subject_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'no_session', 'error', 'لا توجد محاضرة نشطة لهذه المادة');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.student_subjects
    WHERE student_id = v_uid AND subject_id = v_subject_id AND status IN ('active', 'parallel')
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'not_enrolled', 'error', 'هذه المادة ليست ضمن موادك المسجلة');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.webauthn_credentials WHERE id = p_credential_row_id AND student_id = v_uid AND credential_id = p_credential_id
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'no_credential', 'error', 'مفتاح الجهاز غير مرتبط بهذا الحساب');
  END IF;

  INSERT INTO public.attendance_logs (session_id, student_id, latitude, longitude, distance_meters, webauthn_credential_id)
  VALUES (p_session_id, v_uid, p_latitude, p_longitude, p_distance_meters, p_credential_id)
  RETURNING id INTO v_attendance_id;

  UPDATE public.webauthn_credentials
  SET sign_count = p_new_sign_count, last_used_at = NOW()
  WHERE id = p_credential_row_id;

  DELETE FROM public.webauthn_challenges WHERE id = p_challenge_row_id;

  RETURN jsonb_build_object('ok', TRUE, 'attendance_id', v_attendance_id, 'message', 'تم تسجيل حضورك بنجاح');
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', FALSE, 'code', 'already_recorded', 'error', 'تم تسجيل حضورك بالفعل لهذه المحاضرة');
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_in_prepare(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_in_commit(UUID, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, UUID, BIGINT, UUID) TO authenticated;
