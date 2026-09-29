ALTER TABLE public.lecture_sessions
  ADD COLUMN IF NOT EXISTS is_attendance_active BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS audio_token_frequency INTEGER CHECK (audio_token_frequency BETWEEN 16500 AND 17500);

ALTER TABLE public.attendance_logs
  ALTER COLUMN latitude DROP NOT NULL,
  ALTER COLUMN longitude DROP NOT NULL,
  ALTER COLUMN distance_meters DROP NOT NULL,
  ALTER COLUMN webauthn_credential_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS check_in_method TEXT NOT NULL DEFAULT 'webauthn_geofence'
    CHECK (check_in_method IN ('webauthn_geofence', 'audio_beacon', 'manual_admin'));

DROP POLICY IF EXISTS admin_insert_attendance ON public.attendance_logs;
CREATE POLICY admin_insert_attendance ON public.attendance_logs FOR INSERT WITH CHECK (public.is_admin());

CREATE OR REPLACE FUNCTION public.record_audio_attendance(p_session_id UUID, p_detected_frequency NUMERIC)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_student_id UUID := auth.uid(); v_session public.lecture_sessions%ROWTYPE;
BEGIN
  IF v_student_id IS NULL THEN RAISE EXCEPTION 'يجب تسجيل الدخول أولًا'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.students WHERE id = v_student_id AND status = 'approved') THEN RAISE EXCEPTION 'لا يمكن تسجيل الحضور قبل اعتماد الحساب'; END IF;
  SELECT * INTO v_session FROM public.lecture_sessions WHERE id = p_session_id AND is_active = TRUE AND is_attendance_active = TRUE;
  IF NOT FOUND OR v_session.audio_token_frequency IS NULL THEN RAISE EXCEPTION 'لا توجد إشارة صوتية نشطة لهذه المحاضرة'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.student_subjects WHERE student_id = v_student_id AND subject_id = v_session.subject_id) THEN RAISE EXCEPTION 'هذه المادة ليست ضمن موادك المسجلة'; END IF;
  IF abs(p_detected_frequency - v_session.audio_token_frequency) > 50 THEN RAISE EXCEPTION 'لم يتم التحقق من الإشارة الصوتية، اقترب من المحاضر ثم أعد المحاولة'; END IF;
  INSERT INTO public.attendance_logs (session_id, student_id, check_in_method)
  VALUES (p_session_id, v_student_id, 'audio_beacon');
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'تم تسجيل حضورك بالفعل لهذه المحاضرة'; END;
$$;

GRANT EXECUTE ON FUNCTION public.record_audio_attendance(UUID, NUMERIC) TO authenticated;
