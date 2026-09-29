export type AcademicTerm = 'term1' | 'term2' | 'summer';
export type StudentStatus = 'pending' | 'approved' | 'rejected' | 'suspended';

export interface User {
  id: string;
  email?: string;
  name?: string;
}

export interface Admin {
  id: string;
  full_name: string;
  email: string;
  created_at: string;
}

export interface Student {
  id: string;
  national_id: string;
  full_name_ar: string;
  full_name_en: string;
  email: string;
  level: number;
  term: AcademicTerm;
  status: StudentStatus;
  password_reset_requests_used: number;
  created_at: string;
  approved_at?: string | null;
}

export interface Subject {
  id: string;
  name_ar: string;
  level: number;
  term: AcademicTerm;
  max_grade: number;
}

export interface LectureSession {
  id: string;
  subject_id: string;
  opened_by: string;
  opened_at: string;
  closed_at?: string | null;
  is_active: boolean;
  is_attendance_active?: boolean;
  audio_token_frequency?: number | null;
  subject?: Subject;
}

export interface AttendanceLog {
  id: string;
  session_id: string;
  student_id: string;
  checked_in_at: string;
  latitude: number | null;
  longitude: number | null;
  distance_meters: number | null;
  webauthn_credential_id: string | null;
  check_in_method?: 'webauthn_geofence' | 'audio_beacon' | 'manual_admin';
  session?: LectureSession;
}

export interface SecretGrade {
  student_id: string;
  student_name: string;
  national_id: string;
  subject_id: string;
  subject_name: string;
  attended_sessions: number;
  total_sessions: number;
  max_grade: number;
  grade: number;
  enrollment_status?: string | null;
  academic_year?: string | null;
}

export interface GeofenceConfig {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  is_active: boolean;
}

export const TERM_LABELS: Record<AcademicTerm, string> = {
  term1: 'الترم الأول',
  term2: 'الترم الثاني',
  summer: 'الترم الصيفي',
};

export const STATUS_LABELS: Record<StudentStatus, string> = {
  pending: 'بانتظار الموافقة',
  approved: 'معتمد',
  rejected: 'مرفوض',
  suspended: 'موقوف',
};
