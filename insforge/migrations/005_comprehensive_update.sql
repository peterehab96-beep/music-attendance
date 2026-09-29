-- 005_comprehensive_update.sql

ALTER TABLE national_ids ADD COLUMN IF NOT EXISTS level SMALLINT CHECK (level BETWEEN 1 AND 4);

ALTER TABLE national_ids DROP CONSTRAINT IF EXISTS valid_id_format;
ALTER TABLE national_ids ADD CONSTRAINT valid_id_format CHECK (national_id ~ '^(\d{8}|\d{9}|\d{14})$');

ALTER TABLE students DROP CONSTRAINT IF EXISTS valid_student_id_format;
ALTER TABLE students ADD CONSTRAINT valid_student_id_format CHECK (national_id ~ '^(\d{8}|\d{9}|\d{14})$');

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  handled_by UUID REFERENCES admins(id),
  handled_at TIMESTAMPTZ
);
ALTER TABLE password_reset_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS student_own_reset_requests ON password_reset_requests;
CREATE POLICY student_own_reset_requests ON password_reset_requests
  FOR SELECT USING (auth.uid() = student_id);

DROP POLICY IF EXISTS admin_manage_reset_requests ON password_reset_requests;
CREATE POLICY admin_manage_reset_requests ON password_reset_requests
  FOR ALL USING (EXISTS (SELECT 1 FROM admins WHERE id = auth.uid()));

ALTER TABLE attendance_logs DROP CONSTRAINT IF EXISTS attendance_logs_session_id_fkey;
ALTER TABLE attendance_logs ADD CONSTRAINT attendance_logs_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES lecture_sessions(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.calculate_secret_grade(p_student_id UUID, p_subject_id UUID)
RETURNS NUMERIC AS $f$
DECLARE
  total_sessions INT;
  attended_sessions INT;
  max_grade NUMERIC;
BEGIN
  SELECT COUNT(*) INTO total_sessions FROM lecture_sessions WHERE subject_id = p_subject_id AND closed_at IS NOT NULL;
  SELECT COUNT(*) INTO attended_sessions FROM attendance_logs al
    JOIN lecture_sessions ls ON ls.id = al.session_id
    WHERE al.student_id = p_student_id AND ls.subject_id = p_subject_id;
  SELECT s.max_grade INTO max_grade FROM subjects s WHERE s.id = p_subject_id;

  IF total_sessions = 0 THEN RETURN 0; END IF;
  RETURN CEIL((attended_sessions::NUMERIC / total_sessions) * max_grade);
END;
$f$ LANGUAGE plpgsql SECURITY DEFINER;
