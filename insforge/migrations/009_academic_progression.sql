-- 009_academic_progression.sql
-- نظام الترقية وإدارة الراسبين (النظام الهجين).
-- مصدر الحقيقة لحالة الطالب في كل مادة هو student_subjects.status،
-- لا المستوى العام في جدول students. هذا يفصل "المستوى" عن "التسجيل".

-- 1) حالة التسجيل لكل مادة
DO $$ BEGIN
  CREATE TYPE enrollment_status AS ENUM ('active', 'passed', 'failed', 'parallel', 'deferred');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- إضافة الأعمدة الجديدة لجدول student_subjects
ALTER TABLE student_subjects
  ADD COLUMN IF NOT EXISTS status enrollment_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS academic_year VARCHAR(9),
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- 2) تحويل المفتاح الأساسي المركب إلى UUID مستقل، لأن الطالب الراسب
--    سيُسجَّل في نفس المادة مرة ثانية بحالة 'parallel' أو 'deferred'
ALTER TABLE student_subjects DROP CONSTRAINT IF EXISTS student_subjects_pkey;
ALTER TABLE student_subjects ADD COLUMN IF NOT EXISTS id UUID PRIMARY KEY DEFAULT gen_random_uuid();

-- طالب واحد لكل مادة في الحالات "قيد الدراسة" (active أو parallel) —
-- هذا يمنع تكرار تسجيل نفس المادة مرتين في نفس الوقت
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_enrollment
  ON student_subjects(student_id, subject_id)
  WHERE status IN ('active', 'parallel');

-- 3) منطقة العزل: بيانات استمارات الراسبين (لا تُطبَّق مباشرة)
CREATE TABLE IF NOT EXISTS repeater_form_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  national_id VARCHAR(14) NOT NULL,
  student_name_ar TEXT,
  academic_year VARCHAR(9) NOT NULL,
  term_applying_for TEXT NOT NULL CHECK (term_applying_for IN ('term1', 'term2', 'summer')),
  self_reported_case TEXT NOT NULL CHECK (self_reported_case IN ('parallel', 'deferred')),
  failed_subject_ids TEXT[],
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  admin_decision TEXT CHECK (admin_decision IN ('approved', 'rejected', 'corrected')),
  admin_corrected_case TEXT CHECK (admin_corrected_case IN ('parallel', 'deferred')),
  admin_corrected_subjects TEXT[],
  handled_by UUID REFERENCES admins(id),
  handled_at TIMESTAMPTZ,
  student_id UUID REFERENCES students(id)
);

CREATE INDEX IF NOT EXISTS idx_repeater_pending
  ON repeater_form_submissions(admin_decision, academic_year, term_applying_for)
  WHERE admin_decision IS NULL;

ALTER TABLE repeater_form_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_manage_repeater_submissions ON repeater_form_submissions;
CREATE POLICY admin_manage_repeater_submissions ON repeater_form_submissions
  FOR ALL USING (EXISTS (SELECT 1 FROM admins WHERE id = auth.uid()));

-- 4) سجل الترقيات — لا يُحذف منه شيء أبدًا
CREATE TABLE IF NOT EXISTS academic_progression_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id),
  academic_year VARCHAR(9) NOT NULL,
  from_term TEXT,
  to_term TEXT,
  action TEXT NOT NULL CHECK (action IN ('promoted', 'parallel_enrolled', 'deferred', 'manual_override')),
  affected_subject_ids UUID[],
  performed_by UUID NOT NULL REFERENCES admins(id),
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT
);

ALTER TABLE academic_progression_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_read_progression_log ON academic_progression_log;
CREATE POLICY admin_read_progression_log ON academic_progression_log
  FOR SELECT USING (EXISTS (SELECT 1 FROM admins WHERE id = auth.uid()));
DROP POLICY IF EXISTS admin_insert_progression_log ON academic_progression_log;
CREATE POLICY admin_insert_progression_log ON academic_progression_log
  FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM admins WHERE id = auth.uid()));

-- 5) صلاحيات student_subjects: الطالب يقرأ تسجيلاته، الأدمن يعدّلها
DROP POLICY IF EXISTS student_subjects_self_or_admin ON student_subjects;
CREATE POLICY student_subjects_self_or_admin ON student_subjects
  FOR SELECT USING (auth.uid() = student_id OR public.is_admin());
DROP POLICY IF EXISTS admin_manage_enrollments ON student_subjects;
CREATE POLICY admin_manage_enrollments ON student_subjects
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
