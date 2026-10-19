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
    .limit(5000);
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

// ─── إضافة مواد دراسية بعد الاعتماد (ميزة لوحة الطالب) ───

export type AvailableSubject = Subject;
export type MyAddSubjectRequest = {
  request_id: string;
  subject_id: string;
  subject_name: string;
  term: AcademicTerm;
  status: 'pending' | 'approved' | 'rejected';
  requested_at: string;
  handled_at: string | null;
};

/**
 * المواد المتاحة لإضافة/تسجيل: مستوى محدّد + الترم الأول فقط (الحالي).
 * المعلومات يتم جمعها كواجهة خطوة بخطوة: المستوى أولاً ثم الترم ثم المواد.
 */
export async function getAddableSubjects(level: number, term: AcademicTerm) {
  const { data, error } = await database.rpc('available_subjects_for_student', {
    p_level: level,
    p_term: term,
  });
  return { data: (data as AvailableSubject[] | null) ?? [], error };
}

/** إرسال مجموعة طلبات المواد دفعة واحدة — يستثني المواد المسجلة تلقائيًا. */
export async function requestAddSubjects(subjectIds: string[]) {
  const { data, error } = await database.rpc('request_add_subjects', {
    p_subject_ids: subjectIds,
  });
  return { data: (data as number | null) ?? 0, error };
}

/** طلبات الطالب على المواد المضافة (لعرض حالتها في لوحته). */
export async function getMyAddSubjectRequests() {
  const { data, error } = await database.rpc('my_add_subject_requests');
  return { data: (data as MyAddSubjectRequest[] | null) ?? [], error };
}

// ─── لوحة الأدمن: طلبات إضافة المواد المعلقة ───
export type PendingAddSubjectRequest = {
  request_id: string;
  student_id: string;
  student_name: string;
  national_id: string;
  student_email: string;
  level: number;
  subject_id: string;
  subject_name: string;
  term: AcademicTerm;
  requested_at: string;
};

export async function getPendingAddSubjectRequests() {
  const { data, error } = await database.rpc('pending_add_subject_requests');
  return { data: (data as PendingAddSubjectRequest[] | null) ?? [], error };
}

export async function handleAddSubjectRequests(requestIds: string[], approve: boolean) {
  const { data, error } = await database.rpc('handle_add_subject_requests', {
    p_request_ids: requestIds,
    p_approve: approve,
  });
  return { data: (data as number | null) ?? 0, error };
}

// ─── أدمن المواد (المشرف العام فقط) ───
export type SubjectAdminRow = {
  admin_id: string;
  full_name: string;
  email: string;
  subject_ids: string[];
  levels: number[];
  can_review_registrations: boolean;
  is_super: boolean;
  created_at: string;
};

export async function listSubjectAdmins() {
  const { data, error } = await database.rpc('list_subject_admins');
  return { data: (data as SubjectAdminRow[] | null) ?? [], error };
}

export async function createSubjectAdmin(input: { email: string; password: string; fullName: string; subjectIds: string[] }) {
  const { data, error } = await database.rpc('super_create_subject_admin', {
    p_email: input.email,
    p_password: input.password,
    p_full_name: input.fullName,
    p_subject_ids: input.subjectIds,
  });
  return { data: (data as string | null), error };
}

export async function deleteSubjectAdmin(adminId: string) {
  return database.rpc('super_delete_subject_admin', { p_admin_id: adminId });
}

export async function setSubjectAdminSubjects(adminId: string, subjectIds: string[]) {
  return database.rpc('super_set_subject_admin_subjects', {
    p_admin_id: adminId,
    p_subject_ids: subjectIds,
  });
}

/** هل المستخدم الحالي المشرف العام (يرى كل شيء) أم أدمن مادة محصورة؟ */
export async function amISuperAdmin() {
  const { data, error } = await database.rpc('is_super_admin');
  return { data: Boolean(data), error };
}

/**
 * نطاق الأدمن الحالي كما تحسبه قاعدة البيانات: المشرف العام (كل شيء) أو
 * أدمن مادة بموادّه ومستوياته المثبتة + الصلاحيات الممنوحة له من المشرف العام.
 */
export type AdminScope = {
  admin_id: string;
  full_name: string;
  full_name_ar: string;
  full_name_en: string;
  is_super: boolean;
  subject_ids: string[];
  subject_names: string[];
  levels: number[];
  can_review_registrations: boolean;
};

export async function getMyAdminScope() {
  const { data, error } = await database.rpc('my_admin_scope');
  return { data: ((data as AdminScope[] | null) ?? [])[0] ?? null, error };
}

/** منح/سحب «طلبات تسجيل الطلاب» لأدمن مادة — المشرف العام فقط. */
export async function superSetAdminPermissions(adminId: string, canReviewRegistrations: boolean) {
  const { data, error } = await database.rpc('super_set_admin_permissions', {
    p_admin_id: adminId,
    p_can_review_registrations: canReviewRegistrations,
  });
  return { data, error };
}

export type SimpleOutcome = { ok: boolean; error?: string; full_name?: string; full_name_ar?: string; full_name_en?: string };

/** تعديل اسم الأدمن نفسه (عربي + إنجليزي) — مثل الطالب تمامًا. */
export async function updateOwnAdminProfile(fullNameAr: string, fullNameEn: string) {
  const { data, error } = await database.rpc('admin_update_own_profile', {
    p_full_name_ar: fullNameAr,
    p_full_name_en: fullNameEn,
  });
  return { data: (data as SimpleOutcome | null), error };
}

/** تغيير كلمة مرور الأدمن بنفسه — يشترط الحالية وعدد المرات غير محدود. */
export async function changeOwnAdminPassword(currentPassword: string, newPassword: string) {
  const { data, error } = await database.rpc('admin_change_own_password', {
    p_current_password: currentPassword,
    p_new_password: newPassword,
  });
  return { data: (data as SimpleOutcome | null), error };
}

/** المواد المسندة للمستخدم الحالي — NULL للمشرف العام (كل المواد). */
export async function getMyAdminSubjectIds() {
  const { data, error } = await database.rpc('my_admin_subject_ids');
  return { data: (data as string[] | null) ?? null, error }; // null = الكل
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetryable(error: unknown) {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  // أخطاء الشبكة ليس لها statusCode → نعيد المحاولة.
  if (status === undefined || status === 0) return true;
  return RETRYABLE_STATUS.has(status);
}

function isAlreadyRecorded(error: unknown) {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  return status === 409 || message.includes('بالفعل');
}

/**
 * تسجيل الحضور مع إعادة محاولة أسّية + عشوائية (jitter) عند الزحام أو الأخطاء المؤقتة.
 * تحت الحمل العالي (آلاف الطلبات المتزامنة) قد تعيد المنصة 429/503؛ نعيد المحاولة بدل إظهار خطأ للطالب.
 */
export async function checkIn(payload: {
  sessionId: string;
  latitude: number;
  longitude: number;
  webauthnAssertion?: unknown;
}, options: { attempts?: number } = {}) {
  const attempts = Math.max(1, options.attempts ?? 3);
  let last: { data: { message: string } | null; error: unknown } = { data: null, error: null };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await insforge.functions.invoke<{ message: string }>('check-in', { body: payload });
    if (!result.error) return result;
    // نجاح فعلي حصل في محاولة سابقة انقطع ردّها → نعتبره نجاحًا.
    if (isAlreadyRecorded(result.error)) return { data: { message: 'تم تسجيل حضورك بنجاح' }, error: null };
    last = result;
    if (attempt === attempts - 1 || !isRetryable(result.error)) return result;
    const backoff = Math.min(2000, 250 * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, backoff + Math.random() * 250));
  }
  return last;
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

// ─── تعيين كلمة مرور الطالب من لوحة الإدمن ───
// يولّد الإدمن كلمة صريحة تظهر مرة واحدة ليمليها على الطالب (بالوجه أو الهاتف).
// الكلمة لا تُخزَّن في أي جدول — يُخزَّن hash فقط في auth.users.
export async function adminSetStudentPassword(studentId: string, newPassword?: string) {
  const { data, error } = await database.rpc('admin_set_student_password', {
    p_student_id: studentId,
    p_new_password: newPassword ?? null,
  });
  return { data: (data as Array<{ generated_password: string }> | null)?.[0]?.generated_password ?? null, error };
}

/** تعديل اسم الطالب فقط (عربي + إنجليزي) — الاسم الجديد ينتشر في النظام كله لأن القراءة حية من students. */
export async function updateStudentNames(studentId: string, fullNameAr: string, fullNameEn: string) {
  const { data, error } = await database.rpc('admin_update_student_name', {
    p_student_id: studentId,
    p_full_name_ar: fullNameAr,
    p_full_name_en: fullNameEn,
  });
  return { data: (data as { ok: boolean; error?: string } | null), error };
}

export type RetroAttendanceOutcome = {
  ok: boolean;
  code?: string;
  error?: string;
  already_present?: boolean;
  student_id?: string;
  student_name?: string;
  national_id?: string;
  attendance_id?: string;
  checked_in_at?: string;
  message?: string;
};

/** إضافة حضور طالب لجلسة منتهية (سابقة) بالرقم القومي — للأدمن فقط عبر RPC. */
export async function adminAddRetroAttendance(sessionId: string, nationalId: string) {
  const { data, error } = await database.rpc('admin_add_retro_attendance', {
    p_session_id: sessionId,
    p_national_id: nationalId,
  });
  const outcome = Array.isArray(data)
    ? ((data[0] as unknown) as RetroAttendanceOutcome | undefined)
    : (data as RetroAttendanceOutcome | null);
  return { data: outcome ?? null, error };
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

/** حذف سجل حضور طالب من جلسة فعليًا — يُحتسب بعدها غيابًا في كل الكشوفات (أدمن فقط). */
export async function adminRemoveAttendance(attendanceId: string) {
  const { data, error } = await database.rpc('admin_remove_attendance', {
    p_attendance_id: attendanceId,
  });
  const outcome = (data as { ok?: boolean; error?: string; message?: string } | null) ?? null;
  return { data: outcome, error: error ?? (outcome && !outcome.ok ? new Error(outcome.error ?? 'تعذر حذف سجل الحضور.') : null) };
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

// ─── المحرك التلقائي للمادة ٣٥ (إنذار أول/ثاني/حرمان) ───
// أقل عدد محاضرات مغلقة قبل أي إجراء تلقائي — يمنع الإنذار المبكر في بداية الترم.
export const LAW_MIN_SESSIONS = 4;
// المهلة بين كل إجراء والذي يليه (بالأيام) للمحرك التلقائي.
export const LAW_COOLDOWN_DAYS = 7;

export type LawDueSummary = {
  total_violators: number;
  warnings_due: number;
  deprivations_due: number;
  due_now: number;
  blocked: number;
  banned_total: number;
};

/** ملخص المستحق الآن لتنفيذ القانون — يُستخدم في بادج التنبيه التلقائي للإدمن. */
export async function getLawDueSummary(cooldownDays = LAW_COOLDOWN_DAYS, minSessions = LAW_MIN_SESSIONS) {
  const { data, error } = await database.rpc('get_law_due_summary', {
    p_cooldown_days: cooldownDays,
    p_min_sessions: minSessions,
  });
  const row = (data as LawDueSummary[] | null)?.[0] ?? null;
  return { data: row, error };
}

export type LawScanRow = {
  student_id: string;
  student_name: string;
  subject_id: string;
  subject_name: string;
  attendance_percent: number;
  action_type: 'warning' | 'deprivation';
  action_number: number;
  applied: boolean;
  reason: string;
};

/** تنفيذ كل الإجراءات المستحقة الآن (رؤوس الإنذار والحرمان) بضغطة واحدة. */
export async function runLaw35Scan(
  { cooldownDays = LAW_COOLDOWN_DAYS, autoBan = true, dryRun = false, minSessions = LAW_MIN_SESSIONS }:
  { cooldownDays?: number; autoBan?: boolean; dryRun?: boolean; minSessions?: number } = {},
) {
  const { data, error } = await database.rpc('admin_law35_auto_scan', {
    p_cooldown_days: cooldownDays,
    p_auto_ban: autoBan,
    p_dry_run: dryRun,
    p_min_sessions: minSessions,
  });
  return { data: (data as LawScanRow[] | null) ?? [], error };
}

// ─── إشعارات الطالب المرتبطة بالمادة ٣٥ (تصل فور صدورها) ───

export type LawNotification = {
  id: string;
  subject_name: string;
  kind: 'warning1' | 'warning2' | 'deprivation';
  title: string;
  body: string;
  attendance_percent: number | null;
  created_at: string;
  read_at: string | null;
};

export async function getMyLawNotifications() {
  const { data, error } = await database.rpc('get_my_law_notifications');
  return { data: (data as LawNotification[] | null) ?? [], error };
}

export async function markMyLawNotificationsRead() {
  const { data, error } = await database.rpc('mark_my_law_notifications_read');
  return { data: (data as number | null) ?? 0, error };
}

/**
 * طلب استعادة كلمة المرور من صفحة الدخول (بدون جلسة) — للطالب الذي لا يستطيع
 * الدخول أصلًا. لا يعرض النظام أي معلومة عن وجود الحساب؛ الطلب يظهر للإدمن في
 * «طلبات تعيين المرور» ويُسلَّم الطالب كلمة مرور جديدة من الإدمن.
 */
export async function requestPasswordResetWithoutLogin(nationalId: string, email: string) {
  const { data, error } = await insforge.functions.invoke<{ success?: boolean; limited?: boolean; message?: string }>(
    'student-forgot-password',
    { body: { nationalId, email } },
  );
  return { data: data ?? null, error };
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
