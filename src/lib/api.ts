import { database, insforge, readableError } from './insforge';
import type { AcademicTerm, Admin, AttendanceLog, GeofenceConfig, LectureSession, SecretGrade, Student, Subject, User } from './types';

export type WhitelistEntry = { national_id: string; full_name_reference: string | null; level: number | null; is_claimed: boolean; created_at: string };
export type WhitelistImportResult = { inserted_count: number; updated_count: number; skipped_claimed_count: number };

type QueryResult<T> = { data: T | null; error: unknown };

export async function getCurrentUser(): Promise<User | null> {
  const { data } = await insforge.auth.getCurrentUser();
  return (data?.user as User | null) ?? null;
}

export async function signIn(email: string, password: string) {
  return insforge.auth.signInWithPassword({ email, password });
}

export async function signUp(email: string, password: string, name: string) {
  return insforge.auth.signUp({ email, password, name, autoConfirm: true });
}

export async function signOut() {
  await insforge.auth.signOut();
}

export async function completePasswordReset(email: string, code: string, newPassword: string) {
  const exchange = await insforge.auth.exchangeResetPasswordToken({ email, code });
  if (exchange.error || !exchange.data?.token) return { data: null, error: exchange.error ?? new Error('تعذر التحقق من رمز إعادة التعيين.') };
  return insforge.auth.resetPassword({ newPassword, otp: exchange.data.token });
}

export async function getProfile(userId: string) {
  const [studentResult, adminResult] = await Promise.all([
    database.from('students').select('*').eq('id', userId).maybeSingle(),
    database.from('admins').select('*').eq('id', userId).maybeSingle(),
  ]) as [QueryResult<Student>, QueryResult<Admin>];
  return {
    student: studentResult.data,
    admin: adminResult.data,
    error: studentResult.error || adminResult.error,
  };
}

export async function getSubjects(level: number, term: AcademicTerm) {
  let query = database.from('subjects').select('*');
  if (term === 'summer') query = query.lte('level', level).in('term', ['term1', 'term2']);
  else query = query.eq('level', level).eq('term', term);
  const { data, error } = await query.order('level', { ascending: true }).order('name_ar', { ascending: true });
  return { data: (data as Subject[] | null) ?? [], error };
}

export type EnrollmentRow = { subject_id: string; status: string; subjects: Subject | Subject[] | null };

export async function getStudentSubjects(studentId: string) {
  const { data, error } = await database
    .from('student_subjects')
    .select('subject_id, status, subjects(*)')
    .eq('student_id', studentId)
    .in('status', ['active', 'parallel']);
  const subjects = ((data ?? []) as Array<EnrollmentRow>)
    .map((row) => Array.isArray(row.subjects) ? row.subjects[0] : row.subjects)
    .filter((subject): subject is Subject => Boolean(subject));
  return { data: subjects, error };
}

// التسجيلات الحالية مع حالتها (نشط / إعادة موازية / مرحّل) — لعرضها للطالب
export async function getStudentEnrollments(studentId: string) {
  const { data, error } = await database
    .from('student_subjects')
    .select('subject_id, status, academic_year, subjects(id, name_ar, level, term)')
    .eq('student_id', studentId)
    .in('status', ['active', 'parallel', 'deferred'])
    .order('status', { ascending: true });
  return { data: ((data ?? []) as unknown) as EnrollmentRow[], error };
}

export async function registerStudent(input: {
  nationalId: string;
  email: string;
  fullNameAr: string;
  fullNameEn: string;
  level: number;
  term: AcademicTerm;
  subjectIds: string[];
}) {
  const { data, error } = await database.rpc('register_student', {
    p_national_id: input.nationalId,
    p_email: input.email,
    p_full_name_ar: input.fullNameAr,
    p_full_name_en: input.fullNameEn,
    p_level: input.level,
    p_term: input.term,
    p_subject_ids: input.subjectIds,
  });
  return { data, error };
}

export async function validateNationalId(nationalId: string) {
  return insforge.functions.invoke<{ is_available: boolean; full_name_reference?: string | null; level?: number | null; reason: string }>('validate-national-id', {
    body: { national_id: nationalId },
  });
}

export async function importNationalIds(rows: Array<{ national_id: string; full_name_reference?: string; level?: number | null }>) {
  return insforge.functions.invoke<WhitelistImportResult>('import-national-ids', { body: { rows } });
}

export async function getWhitelistEntries() {
  const { data, error } = await database.from('national_ids')
    .select('national_id, full_name_reference, level, is_claimed, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  return { data: (data as WhitelistEntry[] | null) ?? [], error };
}

export async function getActiveSessions() {
  const { data, error } = await database
    .from('lecture_sessions')
    .select('id, subject_id, opened_by, opened_at, closed_at, is_active, is_attendance_active, subjects(*)')
    .eq('is_active', true)
    .order('opened_at', { ascending: false });
  const sessions = (((data ?? []) as unknown) as Array<LectureSession & { subjects?: Subject }>).map((session) => ({
    ...session,
    subject: session.subjects,
  }));
  return { data: sessions, error };
}

export async function getStudentAttendance(studentId: string) {
  const { data, error } = await database
    .from('attendance_logs')
    .select('*, lecture_sessions(id, subject_id, opened_by, opened_at, closed_at, is_active, is_attendance_active, subjects(*))')
    .eq('student_id', studentId)
    .order('checked_in_at', { ascending: false });
  const logs = ((data ?? []) as Array<AttendanceLog & { lecture_sessions?: LectureSession & { subjects?: Subject } }>).map((log) => ({
    ...log,
    session: log.lecture_sessions ? { ...log.lecture_sessions, subject: log.lecture_sessions.subjects } : undefined,
  }));
  return { data: logs, error };
}

export async function checkIn(payload: {
  sessionId: string;
  latitude: number;
  longitude: number;
  webauthnAssertion?: unknown;
}) {
  return insforge.functions.invoke<{ message: string }>('check-in', {
    body: payload,
  });
}

export async function getStudents() {
  const { data, error } = await database.from('students').select('*').order('created_at', { ascending: false });
  return { data: (data as Student[] | null) ?? [], error };
}

export async function updateStudentStatus(studentId: string, status: 'approved' | 'rejected' | 'suspended') {
  return database.from('students').update({
    status,
    approved_at: status === 'approved' ? new Date().toISOString() : null,
  }).eq('id', studentId);
}

export async function getAdminSessions() {
  const { data, error } = await database.rpc('get_admin_lecture_sessions');
  if (error || !data) {
    const fallback = await database
      .from('lecture_sessions')
      .select('id, subject_id, opened_by, opened_at, closed_at, is_active, is_attendance_active, subjects(*)')
      .order('opened_at', { ascending: false })
      .limit(100);
    const sessions = (((fallback.data ?? []) as unknown) as Array<LectureSession & { subjects?: Subject }>).map((session) => ({
      ...session,
      subject: session.subjects,
    }));
    return { data: sessions, error: fallback.error };
  }
  const sessions = (((data ?? []) as unknown) as Array<LectureSession & { subjects?: Subject }>).map((session) => ({
    ...session,
    subject: session.subjects,
  }));
  return { data: sessions, error: null };
}

export async function openLecture(subjectId: string, adminId: string) {
  const { data: duplicate } = await database
    .from('lecture_sessions')
    .select('id')
    .eq('subject_id', subjectId)
    .eq('is_active', true)
    .maybeSingle();
  if (duplicate) return { data: null, error: new Error('توجد محاضرة نشطة لهذه المادة بالفعل.') };
  return database.from('lecture_sessions').insert({ subject_id: subjectId, opened_by: adminId }).select().single();
}

export async function closeLecture(sessionId: string) {
  return database.from('lecture_sessions').update({ is_active: false, closed_at: new Date().toISOString() }).eq('id', sessionId);
}

export async function getSessionAttendance(sessionId: string) {
  const { data, error } = await database
    .from('attendance_logs')
    .select('*, students(full_name_ar, national_id)')
    .eq('session_id', sessionId)
    .order('checked_in_at', { ascending: false });
  return { data: data ?? [], error };
}

export async function getSecretGrades(subjectId?: string) {
  const query = database.rpc('get_secret_grades', subjectId ? { p_subject_id: subjectId } : {});
  const { data, error } = await query;
  return { data: (data as SecretGrade[] | null) ?? [], error };
}

export async function updateStudentGrade(
  studentId: string,
  subjectId: string,
  studentName: string,
  grade: number
) {
  return database.rpc('admin_update_student_grade', {
    p_student_id: studentId,
    p_subject_id: subjectId,
    p_student_name: studentName,
    p_grade: grade,
  });
}

export async function quickAddStudent(
  nationalId: string,
  fullNameAr: string,
  subjectId: string,
  grade?: number
) {
  const { data, error } = await database.rpc('admin_quick_add_student', {
    p_national_id: nationalId,
    p_full_name_ar: fullNameAr,
    p_subject_id: subjectId,
    p_grade: grade ?? null,
  });
  return { data: (data as SecretGrade[] | null)?.[0] ?? null, error };
}

// ─── قانون المادة ٣٥: حضور ومواظبة الطلاب وحرمانهم ───

export type AttendanceComplianceRow = {
  student_id: string;
  student_name: string;
  national_id: string;
  student_status: string;
  level: number;
  subject_id: string;
  subject_name: string;
  attended_sessions: number;
  total_sessions: number;
  attendance_percent: number;
  below_minimum: boolean;
  warning_count: number;
  deduction_count: number;
  is_banned: boolean;
  max_grade: number;
  current_year_work: number | null;
};

export async function getAttendanceCompliance(level?: number, subjectId?: string) {
  const { data, error } = await database.rpc('get_attendance_compliance', {
    p_level: level ?? null,
    p_subject_id: subjectId ?? null,
  });
  return { data: (data as AttendanceComplianceRow[] | null) ?? [], error };
}

export async function executeAttendanceLaw(studentId: string, subjectId: string) {
  const { data, error } = await database.rpc('execute_attendance_law', {
    p_student_id: studentId,
    p_subject_id: subjectId,
  });
  return { data: (data as Array<{ action_type: string; action_number: number; deducted_grade: number | null; is_banned: boolean }> | null) ?? null, error };
}

export async function undoAttendanceLaw(studentId: string, subjectId: string) {
  return database.rpc('undo_attendance_law', { p_student_id: studentId, p_subject_id: subjectId });
}

export type MyAttendanceStatusRow = {
  subject_id: string;
  subject_name: string;
  attendance_percent: number;
  warning_count: number;
  is_banned: boolean;
};

export async function getMyAttendanceStatus() {
  const { data, error } = await database.rpc('get_my_attendance_status');
  return { data: (data as MyAttendanceStatusRow[] | null) ?? [], error };
}

export async function getGeofence() {
  const { data, error } = await database.from('geofence_config').select('*').eq('is_active', true).maybeSingle();
  return { data: data as GeofenceConfig | null, error };
}

export async function updateGeofence(input: Pick<GeofenceConfig, 'label' | 'latitude' | 'longitude' | 'radius_meters'>, adminId: string) {
  const { data: current } = await getGeofence();
  if (!current) return { data: null, error: new Error('لم يتم العثور على إعدادات النطاق الجغرافي.') };
  return database.from('geofence_config').update({ ...input, updated_by: adminId, updated_at: new Date().toISOString() }).eq('id', current.id);
}

export function errorMessage(error: unknown, fallback?: string) {
  return readableError(error, fallback);
}
