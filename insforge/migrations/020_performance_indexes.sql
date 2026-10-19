-- 020_performance_indexes.sql
-- فهارس الأداء لدعم التزامن العالي (آلاف الطلبة يسجلون الحضور في وقت واحد).
-- كل الفهارس idempotent (IF NOT EXISTS) حتى يمكن إعادة تشغيل الـ migration بأمان.

-- students: سياسات RLS والاستعلامات الإدارية تفلتر على الحالة والفرقة والترم.
CREATE INDEX IF NOT EXISTS idx_students_status ON public.students(status);
CREATE INDEX IF NOT EXISTS idx_students_level_term ON public.students(level, term);

-- student_subjects: المفتاح الأساسي (student_id, subject_id) لا يخدم البحث بالمادة.
CREATE INDEX IF NOT EXISTS idx_student_subjects_subject ON public.student_subjects(subject_id);
CREATE INDEX IF NOT EXISTS idx_student_subjects_subject_status ON public.student_subjects(subject_id, status);

-- lecture_sessions: استعلام "المحاضرات النشطة" هو الأكثر تكرارًا تحت الحمل.
CREATE INDEX IF NOT EXISTS idx_sessions_active_only ON public.lecture_sessions(subject_id, opened_at DESC) WHERE is_active = TRUE;

-- attendance_logs: UNIQUE(session_id, student_id) يخدم جلسة بعينها، لكن التقارير الزمنية تحتاج فهرسًا مستقلًا.
CREATE INDEX IF NOT EXISTS idx_attendance_checked_in ON public.attendance_logs(checked_in_at DESC);

-- webauthn_credentials: تسجيل الدخول بالبصمة يبحث بـ (student_id, credential_id).
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_student ON public.webauthn_credentials(student_id);

-- webauthn_challenges: البحث عن أحدث تحدٍّ صالح لكل مستخدم.
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_lookup ON public.webauthn_challenges(user_id, flow, expires_at DESC);

-- national_ids: التحقق من رقم قومي غير مُطالَب به (partial index أصغر وأسرع).
CREATE INDEX IF NOT EXISTS idx_national_ids_unclaimed ON public.national_ids(national_id) WHERE is_claimed = FALSE;

-- attendance_law_actions: تقارير المادة الواحدة.
CREATE INDEX IF NOT EXISTS idx_law_actions_subject ON public.attendance_law_actions(subject_id);
CREATE INDEX IF NOT EXISTS idx_law_actions_student ON public.attendance_law_actions(student_id);

-- audit_logs: لوحة السجلات مرتبة زمنيًا.
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs(created_at DESC);

-- تحديث إحصائيات المخطّط ليستفيد المُخطِّط فورًا من الفهارس الجديدة.
ANALYZE public.students;
ANALYZE public.student_subjects;
ANALYZE public.lecture_sessions;
ANALYZE public.attendance_logs;
ANALYZE public.webauthn_credentials;
ANALYZE public.webauthn_challenges;
ANALYZE public.attendance_law_actions;
