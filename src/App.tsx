import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  CalendarCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  Clock3,
  Copy,
  Download,
  FileSpreadsheet,
  Fingerprint,
  Globe2,
  GraduationCap,
  KeyRound,
  Laptop,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  MapPin,
  Menu,
  Palette,
  Pencil,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  amISuperAdmin,
  changeOwnAdminPassword,
  createSubjectAdmin,
  deleteSubjectAdmin,
  getAddableSubjects,
  getMyAdminScope,
  superSetAdminPermissions,
  updateOwnAdminProfile,
  getMyAddSubjectRequests,
  getMyAdminSubjectIds,
  getPendingAddSubjectRequests,
  handleAddSubjectRequests,
  listSubjectAdmins,
  requestAddSubjects,
  setSubjectAdminSubjects,
  adminAddRetroAttendance,
  adminSetStudentPassword,
  checkIn,
  errorMessage,
  executeAttendanceLaw,
  adminRemoveAttendance,
  getActiveSessions,
  getAdminSessions,
  getAttendanceCompliance,
  getCurrentUser,
  getGeofence,
  getLawDueSummary,
  getMyAttendanceStatus,
  getMyLawNotifications,
  getProfile,
  getSecretGrades,
  getSessionAttendance,
  getStudentAttendance,
  getStudentSubjects,
  getStudents,
  getWhitelistEntries,
  getSubjects,
  importNationalIds,
  openLecture,
  quickAddStudent,
  registerStudent,
  requestPasswordResetWithoutLogin,
  runLaw35Scan,
  signIn,
  signOut,
  undoAttendanceLaw,
  updateGeofence,
  updateStudentGrade,
  updateStudentNames,
  updateStudentStatus,
  validateNationalId,
  LAW_COOLDOWN_DAYS,
  LAW_MIN_SESSIONS,
  logLoginEvent,
  markMyLawNotificationsRead,
  type AdminScope,
  type AttendanceComplianceRow,
  type MyAddSubjectRequest,
  type PendingAddSubjectRequest,
  type SubjectAdminRow,
  type LawDueSummary,
  type LawNotification,
  type MyAttendanceStatusRow,
} from './lib/api';
import { parseWhitelistFile } from './lib/whitelist';
import { PasswordField } from './components/PasswordField';
import { PrintableAttendanceSheet } from './components/admin/PrintableAttendanceSheet';
import { AdminAudioBeacon } from './components/admin/AdminAudioBeacon';
import { BulkPromotionPanel } from './components/admin/BulkPromotionPanel';
import { RepeaterReviewPanel } from './components/admin/RepeaterReviewPanel';
import { StudentAudioReceiver } from './components/student/StudentAudioReceiver';
import { AdminAuditLog } from './components/admin/AdminAuditLog';
import { EnrollmentStatus } from './components/student/EnrollmentStatus';
import { database, insforge } from './lib/insforge';
import { readCurrentLocation, supportsPasskeys } from './lib/device';
import type { AcademicTerm, Admin, AttendanceLog, GeofenceConfig, LectureSession, SecretGrade, Student, Subject, User } from './lib/types';
import { STATUS_LABELS, TERM_LABELS } from './lib/types';

type AuthView = 'login' | 'register';
type AdminTab = 'overview' | 'students' | 'passwords' | 'whitelist' | 'sessions' | 'grades' | 'addSubjectsQueue' | 'subjectAdmins' | 'promotion' | 'repeaters' | 'law35' | 'audit' | 'settings';
type StudentTab = 'dashboard' | 'attendance' | 'addSubjects' | 'profile';

const publicRoutes: Record<AuthView, string> = {
  login: '/login',
  register: '/register',
};

const studentRoutes: Record<StudentTab, string> = {
  dashboard: '/student/dashboard',
  attendance: '/student/attendance',
  addSubjects: '/student/add-subjects',
  profile: '/student/profile',
};

const adminRoutes: Record<AdminTab, string> = {
  overview: '/admin/dashboard',
  students: '/admin/students',
  passwords: '/admin/passwords',
  whitelist: '/admin/whitelist',
  sessions: '/admin/sessions',
  grades: '/admin/grades',
  addSubjectsQueue: '/admin/add-subjects',
  subjectAdmins: '/admin/subject-admins',
  promotion: '/admin/promotion',
  repeaters: '/admin/repeaters',
  law35: '/admin/law35',
  audit: '/admin/audit',
  settings: '/admin/settings',
};

function authViewFromPath(path: string): AuthView {
  if (path === publicRoutes.register) return 'register';
  return 'login';
}

function studentTabFromPath(path: string): StudentTab {
  if (path === studentRoutes.attendance) return 'attendance';
  if (path === studentRoutes.addSubjects) return 'addSubjects';
  if (path === studentRoutes.profile) return 'profile';
  return 'dashboard';
}

function adminTabFromPath(path: string): AdminTab {
  if (path === adminRoutes.students) return 'students';
  if (path === adminRoutes.passwords) return 'passwords';
  if (path === adminRoutes.whitelist) return 'whitelist';
  if (path === adminRoutes.sessions) return 'sessions';
  if (path === adminRoutes.grades) return 'grades';
  if (path === adminRoutes.addSubjectsQueue) return 'addSubjectsQueue';
  if (path === adminRoutes.subjectAdmins) return 'subjectAdmins';
  if (path === adminRoutes.promotion) return 'promotion';
  if (path === adminRoutes.repeaters) return 'repeaters';
  if (path === adminRoutes.law35) return 'law35';
  if (path === adminRoutes.audit) return 'audit';
  if (path === adminRoutes.settings) return 'settings';
  return 'overview';
}

function userFacingDeviceError(error: unknown, fallback: string) {
  const message = errorMessage(error, fallback);
  const lower = message.toLowerCase();
  if (lower.includes('notallowed') || lower.includes('not allowed') || lower.includes('abort') || lower.includes('cancel')) {
    return 'تم إلغاء العملية أو منعها من المتصفح. افتح الموقع من Safari أو Chrome مباشرة، واسمح بالبصمة/Face ID عند ظهور الطلب.';
  }
  if (lower.includes('security') || lower.includes('rp id') || lower.includes('origin')) {
    return 'تعذر تأكيد أمان الرابط الحالي. افتح الموقع من الرابط المنشور مباشرة بدون متصفح داخل تطبيق آخر.';
  }
  if (lower.includes('location') || message.includes('موقع')) {
    return 'تعذر قراءة موقعك. فعّل خدمة الموقع واسمح للمتصفح بالوصول إليها من إعدادات الهاتف.';
  }
  return message;
}

const colors = {
  ink: '#153a35',
  clay: '#bd6546',
  cream: '#f6f1e8',
};

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [student, setStudent] = useState<Student | null>(null);
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [booting, setBooting] = useState(true);
  const [path, setPath] = useState(() => window.location.pathname);
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [theme, setTheme] = useState<'modern' | 'classic'>(() => {
    return (localStorage.getItem('ui_theme') as 'modern' | 'classic') || 'modern';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ui_theme', theme);
  }, [theme]);

  const navigate = useCallback((nextPath: string, replace = false) => {
    if (window.location.pathname !== nextPath) {
      if (replace) window.history.replaceState(null, '', nextPath);
      else window.history.pushState(null, '', nextPath);
    }
    setPath(nextPath);
  }, []);

  const notify = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 4500);
  }, []);

  const loadProfile = useCallback(async (currentUser: User) => {
    const profile = await getProfile(currentUser.id);
    if (profile.admin) setAdmin(profile.admin);
    if (profile.student) setStudent(profile.student);
    return profile;
  }, []);

  useEffect(() => {
    const updatePath = () => setPath(window.location.pathname);
    window.addEventListener('popstate', updatePath);
    const params = new URLSearchParams(window.location.search);
    const googleParam = params.get('google');
    if (googleParam === 'connected') {
      notify('تم ربط حساب Google بنجاح! يمكنك الآن تصدير الدرجات إلى Google Sheets مباشرة بنقرة زر.', 'success');
      window.history.replaceState(null, '', window.location.pathname);
    } else if (googleParam === 'storage_error' || googleParam === 'error' || googleParam === 'invalid_state') {
      notify('تعذر إتمام ربط حساب Google. يرجى المحاولة مرة أخرى.', 'error');
      window.history.replaceState(null, '', window.location.pathname);
    }
    return () => window.removeEventListener('popstate', updatePath);
  }, [notify]);

  useEffect(() => {
    let active = true;
    getCurrentUser().then(async (currentUser) => {
      if (!active) return;
      setUser(currentUser);
      if (currentUser) await loadProfile(currentUser);
      setBooting(false);
    }).catch(() => setBooting(false));
    return () => { active = false; };
  }, [loadProfile]);

  useEffect(() => {
    if (booting) return;
    const isPublicRoute = Object.values(publicRoutes).includes(path as typeof publicRoutes[keyof typeof publicRoutes]) || path === '/';
    if (!user && !isPublicRoute) navigate(publicRoutes.login, true);
    if (user && admin && !path.startsWith('/admin')) navigate(adminRoutes.overview, true);
    if (user && student && !path.startsWith('/student')) navigate(studentRoutes.dashboard, true);
  }, [admin, booting, navigate, path, student, user]);

  async function handleSignedIn(currentUser: User) {
    setUser(currentUser);
    const profile = await loadProfile(currentUser);
    if (profile.admin) navigate(adminRoutes.overview, true);
    if (profile.student) navigate(studentRoutes.dashboard, true);
    if (!profile.student && !profile.admin) notify('تم تسجيل الدخول، لكن لم يتم العثور على ملف الحساب بعد.', 'info');
  }

  async function handleLogout() {
    await signOut();
    setUser(null);
    setStudent(null);
    setAdmin(null);
    navigate(publicRoutes.login, true);
  }

  if (booting) return <LoadingScreen />;

  return (
    <>
      {user && (student || admin) ? (
        admin ? <AdminShell admin={admin} path={path} navigate={navigate} notify={notify} onLogout={handleLogout} theme={theme} setTheme={setTheme} /> : <StudentShell student={student!} user={user} path={path} navigate={navigate} notify={notify} onLogout={handleLogout} />
      ) : path === '/' ? (
        <HomePage onLogin={() => navigate(publicRoutes.login)} onRegister={() => navigate(publicRoutes.register)} />
      ) : (
        <AuthShell view={authViewFromPath(path)} setView={(view) => navigate(publicRoutes[view])} onSignedIn={handleSignedIn} notify={notify} />
      )}
      {toast && <Toast {...toast} onClose={() => setToast(null)} />}
    </>
  );
}

function HomePage({ onLogin, onRegister }: { onLogin: () => void; onRegister: () => void }) {
  return <main className="home-page">
    <header className="home-header">
      <div className="brand-lockup"><div className="brand-mark">ح</div><div><strong>حضور</strong><span>نظام قسم التربية الموسيقية</span></div></div>
      <div className="home-actions"><button className="secondary-button" onClick={onRegister}><UserPlus size={17} /> إنشاء حساب طالب</button><button className="primary-button" onClick={onLogin}><LockKeyhole size={17} /> تسجيل الدخول</button></div>
    </header>
    <section className="home-hero">
      <div className="home-copy">
        <span className="eyebrow">جامعة الزقازيق · كلية التربية النوعية</span>
        <h1>قسم التربية الموسيقية</h1>
        <p>بوابة إلكترونية داخلية لتنظيم تسجيل حضور الطلاب، متابعة المحاضرات، وحساب أعمال السنة بطريقة دقيقة وآمنة تراعي خصوصية الطالب ومتطلبات الإدارة الأكاديمية.</p>
        <div className="home-cta"><button className="primary-button" onClick={onLogin}>دخول إلى النظام <ArrowLeft size={17} /></button><button className="secondary-button" onClick={onRegister}>تسجيل طالب جديد</button></div>
      </div>
      <div className="home-panel">
        <div className="home-panel-top"><BadgeCheck size={20} /><span>منصة تشغيل أكاديمية</span></div>
        <div className="home-score"><strong>حضور</strong><span>تسجيل لحظي مع تحقق من الطالب والموقع والجهاز</span></div>
        <div className="home-features"><span><ShieldCheck size={16} /> صلاحيات محمية</span><span><Fingerprint size={16} /> Passkey للطلاب</span><span><MapPin size={16} /> نطاق جغرافي</span></div>
      </div>
    </section>
    <section className="home-info-grid">
      <article><GraduationCap size={22} /><h2>عن الجامعة</h2><p>جامعة الزقازيق مؤسسة تعليمية مصرية تخدم التعليم والبحث والمجتمع، ويأتي النظام لدعم التحول الرقمي داخل بيئة أكاديمية منضبطة.</p></article>
      <article><Laptop size={22} /><h2>عن الكلية</h2><p>كلية التربية النوعية تهتم بإعداد كوادر مؤهلة في التخصصات النوعية، مع احتياج عملي لأدوات دقيقة لإدارة الطلاب والمحاضرات.</p></article>
      <article><Globe2 size={22} /><h2>عن القسم</h2><p>قسم التربية الموسيقية يحتاج إلى حضور عملي ومنتظم، لذلك يربط النظام الطالب بالمادة والمحاضرة والحضور الفعلي داخل نطاق الكلية.</p></article>
    </section>
  </main>;
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="brand-mark small">ح</div><div className="spinner" /><span>جارٍ تجهيز النظام…</span></div>;
}

function Toast({ type, message, onClose }: { type: 'success' | 'error' | 'info'; message: string; onClose: () => void }) {
  const Icon = type === 'success' ? CheckCircle2 : type === 'error' ? AlertTriangle : CircleHelp;
  return <div className={`toast ${type}`} role="status"><Icon size={18} /><span>{message}</span><button onClick={onClose} aria-label="إغلاق"><X size={16} /></button></div>;
}

function AuthShell({ view, setView, onSignedIn, notify }: { view: AuthView; setView: (view: AuthView) => void; onSignedIn: (user: User) => Promise<void>; notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  return <main className="auth-page">
    <div className="auth-ornament ornament-one" /><div className="auth-ornament ornament-two" />
    <section className="auth-intro">
      <div className="brand-lockup"><div className="brand-mark">ح</div><div><strong>حضور</strong><span>قسم التربية الموسيقية</span></div></div>
      <div className="intro-copy"><span className="eyebrow">جامعة الزقازيق · كلية التربية النوعية</span><h1>حضورك<br /><em>يصنع الإيقاع.</em></h1><p>منصة آمنة وموثوقة لتسجيل حضور الطلاب ومتابعة سجل المحاضرات، مصممة بخصوصية تامة.</p></div>
      <div className="trust-row"><span><ShieldCheck size={17} /> حماية بالـ Passkey</span><span><MapPin size={17} /> تحقق جغرافي</span></div>
    </section>
    <section className="auth-card-wrap"><div className="auth-card"><div className="mobile-brand brand-lockup"><div className="brand-mark">ح</div><div><strong>حضور</strong><span>التربية الموسيقية</span></div></div>{view === 'login' ? <LoginForm onSignedIn={onSignedIn} notify={notify} onRegister={() => setView('register')} /> : <RegisterForm onSignedIn={onSignedIn} notify={notify} onLogin={() => setView('login')} />}</div><p className="auth-footer footer-copyright" dir="ltr">© 2026 Dr. Peter Ehab Atef Ezzat. All rights reserved.</p></section>
  </main>;
}

function LoginForm({ onSignedIn, notify, onRegister }: { onSignedIn: (user: User) => Promise<void>; notify: (message: string, type?: 'success' | 'error' | 'info') => void; onRegister: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // مسار الطالب الذي لا يستطيع الدخول أصلًا (ناسي كلمة المرور أو اليوزر):
  // يرسل طلبًا للإدارة من صفحة الدخول بدون أي جلسة، ويظهر الطلب في لوحة الإدمن
  // ليولّد له كلمة مرور جديدة ويسلمها له.
  const [showHelp, setShowHelp] = useState(false);
  const [helpId, setHelpId] = useState('');
  const [helpEmail, setHelpEmail] = useState('');
  const [helpBusy, setHelpBusy] = useState(false);
  const [helpMessage, setHelpMessage] = useState('');
  async function submitHelp(event: React.FormEvent) {
    event.preventDefault();
    const mail = (helpEmail || '').trim() || email.trim();
    if (!helpId.trim() || !mail) return notify('أدخل الرقم القومي والبريد الإلكتروني.', 'error');
    setHelpBusy(true);
    setHelpMessage('');
    const res = await requestPasswordResetWithoutLogin(helpId.trim(), mail);
    setHelpBusy(false);
    if (res.error) return notify(errorMessage(res.error, 'تعذر إرسال الطلب. حاول مرة أخرى.'), 'error');
    setHelpMessage(res.data?.message ?? 'تم إرسال طلبك إلى إدارة القسم.');
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const { data, error } = await signIn(email.trim(), password);
    setBusy(false);
    if (error || !data?.user) {
      // كل محاولة فاشلة تُسجَّل بالوقت والشبكة والجهاز لتمكين تتبع أي محاولة اختراق،
      // لكن بدون طلب الموقع من شخص لم يدخل بعد.
      const raw = errorMessage(error, 'تعذر تسجيل الدخول. راجع البريد وكلمة المرور.');
      // رسالة الخادم لاتينية ومبهمة؛ نوضحها بالعربية ونحفظ النص التقني في السجل فقط.
      const rejected = /invalid|credential/i.test(raw);
      void logLoginEvent({ status: 'failed', identity: email.trim(), method: 'password', failureReason: rejected ? 'بيانات الدخول غير صحيحة' : raw, withLocation: false });
      return notify(rejected ? 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' : raw, 'error');
    }
    // سجل الدخول الكامل (الوقت/العنوان/الجهاز/الموقع) — لا يعطّل الدخول إن فشل.
    void logLoginEvent({ status: 'success', identity: email.trim(), userId: data.user.id, method: 'password' });
    await onSignedIn(data.user as User);
    notify('مرحبًا بعودتك.', 'success');
  }
  return <><div className="form-heading"><span className="eyebrow">مرحبًا بعودتك</span><h2>تسجيل الدخول</h2><p>أدخل بيانات حسابك للوصول إلى لوحة الحضور.</p></div><form onSubmit={submit} className="stack-form"><label>البريد الإلكتروني<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@zu.edu.eg" required autoComplete="email" dir="ltr" /></label><label>كلمة المرور<PasswordField value={password} onChange={setPassword} placeholder="أدخل كلمة المرور" required autoComplete="current-password" /></label><button className="primary-button full" disabled={busy}>{busy ? <><span className="button-spinner" /> جارٍ الدخول…</> : <>دخول إلى الحساب <ArrowLeft size={17} /></>}</button></form>
  <div className="auth-switch"><span>ليس لديك حساب؟</span><button onClick={onRegister}>إنشاء حساب طالب</button></div>
  <div className="auth-switch"><span>ناسي كلمة المرور أو البريد؟</span><button onClick={() => setShowHelp((v) => !v)}>{showHelp ? 'إغلاق' : 'اطلب كلمة مرور جديدة'}</button></div>
  {showHelp && <form onSubmit={submitHelp} className="stack-form reset-form">
    <div className="status-alert"><div className="alert-icon"><LockKeyhole size={20} /></div><div><b>استعادة كلمة المرور</b><p>أدخل رقمك القومي والبريد الذي سجّلت به، وسيصل الطلب لإدارة القسم ويُسلَّم لك كلمة مرور جديدة. لا نعرض أي كلمة مرور قديمة — فالحسابات مؤمّنة بتشفير لا يمكن فكّه.</p></div></div>
    <label>الرقم القومي<input value={helpId} onChange={(event) => setHelpId(event.target.value)} placeholder="14 رقمًا" inputMode="numeric" dir="ltr" required /></label>
    <label>البريد الإلكتروني المسجّل<input type="email" value={helpEmail || email} onChange={(event) => setHelpEmail(event.target.value)} placeholder="name@zu.edu.eg" dir="ltr" required /></label>
    {helpMessage && <div className="status-alert"><div><b>تم الإرسال</b><p>{helpMessage}</p></div></div>}
    <button className="secondary-button" disabled={helpBusy}>{helpBusy ? 'جارٍ الإرسال…' : 'إرسال الطلب للإدارة'}</button>
  </form>}
  <div className="security-note"><Fingerprint size={20} /><span><b>دخول آمن ومسجَّل</b><small>نستخدم تشفيرًا حديثًا ولا نخزّن أي صورة شخصية. يُسجَّل كل دخول بالوقت والجهاز والشبكة والموقع لحماية حسابك وتتبّع أي محاولة غير مصرّح بها.</small></span></div></>;
}



function RegisterForm({ onSignedIn, notify, onLogin }: { onSignedIn: (user: User) => Promise<void>; notify: (message: string, type?: 'success' | 'error' | 'info') => void; onLogin: () => void }) {
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ nationalId: '', fullNameAr: '', fullNameEn: '', email: '', password: '', level: 1, term: 'term1' as AcademicTerm });
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selected, setSelected] = useState<string[]>([]);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) { setForm((previous) => ({ ...previous, [key]: value })); }

  useEffect(() => {
    let active = true;
    async function checkId() {
      const nid = form.nationalId;
      if (/^(\d{6,9}|\d{14})$/.test(nid)) {
        const whitelist = await validateNationalId(nid);
        if (active && !whitelist.error && whitelist.data?.level) {
          update('level', whitelist.data.level);
        }
      }
    }
    void checkId();
    return () => { active = false; };
  }, [form.nationalId]);

  async function loadAvailableSubjects() {
    if (!/^(\d{6,9}|\d{14})$/.test(form.nationalId)) return notify('الرقم القومي أو الهوية غير صحيحة', 'error');
    const arWords = form.fullNameAr.trim().split(/\s+/).filter(Boolean);
    const enWords = form.fullNameEn.trim().split(/\s+/).filter(Boolean);
    if (arWords.length < 4 || !/^[\u0600-\u065F\u066A-\u06D2\s]+$/.test(form.fullNameAr)) return notify('يجب إدخال الاسم الرباعي باللغة العربية', 'error');
    if (enWords.length < 4 || !/^[A-Za-z\s]+$/.test(form.fullNameEn)) return notify('يجب إدخال الاسم الرباعي باللغة الإنجليزية', 'error');
    const whitelist = await validateNationalId(form.nationalId);
    if (whitelist.error || !whitelist.data?.is_available) return notify(whitelist.data?.reason === 'claimed' ? 'تم تسجيل هذا الرقم القومي من قبل.' : 'الرقم القومي غير مسجل في قوائم الكلية.', 'error');
    if (whitelist.data?.level) { update('level', whitelist.data.level); }
    const levelToUse = whitelist.data?.level || form.level;
    const result = await getSubjects(levelToUse, form.term);
    if (result.error) return notify(errorMessage(result.error, 'تعذر تحميل المواد.'), 'error');
    setSubjects(result.data);
    setSelected([]);
    setStep(2);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected.length) return notify('اختر مادة واحدة على الأقل للمتابعة.', 'error');
    setBusy(true);
    let { data: signUpData, error: signUpError } = await insforge.auth.signUp({ email: form.email.trim(), password: form.password, name: form.fullNameAr, autoConfirm: true });
    // If a previous attempt created the auth account but failed before its student row,
    // signing in lets the same request resume instead of leaving the account unusable.
    if (signUpError || !signUpData?.user) {
      const signInResult = await signIn(form.email.trim(), form.password);
      if (!signInResult.error && signInResult.data?.user) { signUpData = signInResult.data; signUpError = null; }
    }
    if (signUpError || !signUpData?.user) { setBusy(false); return notify(errorMessage(signUpError, 'تعذر إنشاء الحساب.'), 'error'); }
    const result = await registerStudent({ nationalId: form.nationalId.trim(), email: form.email.trim(), fullNameAr: form.fullNameAr.trim(), fullNameEn: form.fullNameEn.trim(), level: form.level, term: form.term, subjectIds: selected });
    if (result.error) { setBusy(false); return notify(errorMessage(result.error, 'تعذر إكمال تسجيل الطالب.'), 'error'); }
    await tryRegisterPasskey();
    await onSignedIn(signUpData.user as User);
    void logLoginEvent({ status: 'success', identity: form.email.trim(), userId: signUpData.user.id, method: 'register' });
    setBusy(false);
    notify('تم إنشاء الحساب. سيظهر لك سجل الحضور بعد اعتماد الإدمن.', 'success');
  }
  async function tryRegisterPasskey() {
    if (!supportsPasskeys()) return;
    try {
      const options = await insforge.functions.invoke<Record<string, unknown>>('webauthn-register-options', { body: { student_id: (await getCurrentUser())?.id } });
      if (options.error || !options.data) return;
      const credential = await startRegistration({ optionsJSON: options.data as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'] });
      await insforge.functions.invoke('webauthn-register-verify', { body: { credential } });
    } catch { /* A student can complete passkey setup from the profile after signing in. */ }
  }
  const passwordStrong = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(form.password);
  return <><div className="form-heading"><span className="eyebrow">خطوة {step} من 2</span><h2>إنشاء حساب طالب</h2><p>{step === 1 ? 'تحقق من الرقم القومي وأكمل بياناتك الأساسية.' : 'اختر المواد التي ستسجل حضورها هذا الترم.'}</p></div><div className="progress-line"><span className={step >= 1 ? 'active' : ''} /><span className={step >= 2 ? 'active' : ''} /></div>{step === 1 ? <form onSubmit={(event) => { event.preventDefault(); void loadAvailableSubjects(); }} className="stack-form"><label>الرقم القومي<input value={form.nationalId} onChange={(event) => update('nationalId', event.target.value.replace(/\D/g, '').slice(0, 14))} placeholder="الرقم القومي المصري أو الرقم المدني العماني" inputMode="numeric" maxLength={14} required dir="ltr" /></label><div className="two-fields"><label>الاسم بالعربية<input value={form.fullNameAr} onChange={(event) => update('fullNameAr', event.target.value)} required /></label><label>الاسم بالإنجليزية<input value={form.fullNameEn} onChange={(event) => update('fullNameEn', event.target.value)} required dir="ltr" /></label></div><div className="two-fields"><label>الفرقة<select value={form.level} onChange={(event) => update('level', Number(event.target.value))} disabled><option value={1}>الفرقة الأولى</option><option value={2}>الفرقة الثانية</option><option value={3}>الفرقة الثالثة</option><option value={4}>الفرقة الرابعة</option></select></label><label>الترم<select value={form.term} onChange={(event) => update('term', event.target.value as AcademicTerm)}><option value="term1">الترم الأول</option><option value="term2">الترم الثاني</option><option value="summer">الترم الصيفي</option></select></label></div><label>البريد الإلكتروني<input type="email" value={form.email} onChange={(event) => update('email', event.target.value)} placeholder="name@zu.edu.eg" required dir="ltr" /></label><label>كلمة مرور قوية<PasswordField value={form.password} onChange={(value) => update('password', value)} required minLength={8} />{form.password && <small className={passwordStrong ? 'valid-hint' : 'error-hint'}>{passwordStrong ? 'كلمة المرور مستوفية للشروط' : 'يجب أن تشمل حرفًا كبيرًا وصغيرًا ورقمًا ورمزًا'}</small>}</label><button className="primary-button full" disabled={!passwordStrong}>متابعة لاختيار المواد <ArrowLeft size={17} /></button></form> : <form onSubmit={submit} className="stack-form">{subjects.length > 0 && <div className="picker-toolbar"><span className="picker-hint">تم تحديد <strong>{selected.length}</strong> من <strong>{subjects.length}</strong> مادة</span><button type="button" className={`select-all-pill ${selected.length === subjects.length ? 'all-active' : ''}`} onClick={() => setSelected(selected.length === subjects.length ? [] : subjects.map((s) => s.id))}><span className="pill-check-indicator">{selected.length === subjects.length ? <Check size={11} strokeWidth={3} /> : selected.length > 0 ? <span className="pill-dash" /> : null}</span><span>{selected.length === subjects.length ? 'إلغاء' : 'تحديد الكل'}</span></button></div>}<div className="subject-picker">{subjects.length ? subjects.map((subject) => <label key={subject.id} className={`subject-option ${selected.includes(subject.id) ? 'selected' : ''}`}><input type="checkbox" checked={selected.includes(subject.id)} onChange={() => setSelected((current) => current.includes(subject.id) ? current.filter((id) => id !== subject.id) : [...current, subject.id])} /><span className="check-box">{selected.includes(subject.id) && <Check size={15} />}</span><span><b>{subject.name_ar}</b><small>{subject.level === form.level ? 'مادة مقررة' : 'مادة متاحة للترم الصيفي'}</small></span></label>) : <div className="empty-state compact">لا توجد مواد متاحة بهذه البيانات.</div>}</div><div className="passkey-callout"><Fingerprint size={24} /><div><b>تسجيل مفتاح الجهاز</b><p>سنطلب بصمة الهاتف أو Face ID لحماية تسجيل الحضور. لا نلتقط أو نخزن أي صورة.</p></div></div><button className="primary-button full" disabled={busy || !selected.length}>{busy ? <><span className="button-spinner" /> جارٍ إنشاء الحساب…</> : <>إنشاء الحساب <UserPlus size={17} /></>}</button><button type="button" className="text-button" onClick={() => setStep(1)}>العودة لتعديل البيانات</button></form>}<div className="auth-switch"><span>لديك حساب بالفعل؟</span><button onClick={onLogin}>تسجيل الدخول</button></div></>;
}

function AppHeader({ title, subtitle, onLogout, onMenu }: { title: string; subtitle: string; onLogout: () => void; onMenu?: () => void }) {
  return <header className="app-header"><div className="header-title"><button className="menu-button" onClick={onMenu} aria-label="القائمة"><Menu size={21} /></button><div><h1>{title}</h1><span>{subtitle}</span></div></div><div className="header-actions"><div className="header-date"><CalendarCheck size={17} /> {new Intl.DateTimeFormat('ar-EG', { dateStyle: 'full' }).format(new Date())}</div><button className="icon-button" onClick={onLogout} title="تسجيل الخروج"><LogOut size={18} /></button></div></header>;
}

function StudentShell({ student, user, path, navigate, notify, onLogout }: { student: Student; user: User; path: string; navigate: (path: string, replace?: boolean) => void; notify: (message: string, type?: 'success' | 'error' | 'info') => void; onLogout: () => void }) {
  const tab = studentTabFromPath(path);
  const [mobileNav, setMobileNav] = useState(false);
  return (
    <div className="app-layout">
      <div className={`sidebar-backdrop ${mobileNav ? 'active' : ''}`} onClick={() => setMobileNav(false)} aria-hidden="true" />
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <SidebarBrand />
        <nav>
          <button className={tab === 'dashboard' ? 'nav-active' : ''} onClick={() => { navigate(studentRoutes.dashboard); setMobileNav(false); }}>
            <LayoutDashboard size={19} />
            <span>الرئيسية</span>
          </button>
          <button className={tab === 'attendance' ? 'nav-active' : ''} onClick={() => { navigate(studentRoutes.attendance); setMobileNav(false); }}>
            <CalendarCheck size={19} />
            <span>سجل الحضور</span>
          </button>
          <button className={tab === 'addSubjects' ? 'nav-active' : ''} onClick={() => { navigate(studentRoutes.addSubjects); setMobileNav(false); }}>
            <GraduationCap size={19} />
            <span>إضافة مواد دراسية</span>
          </button>
          <button className={tab === 'profile' ? 'nav-active' : ''} onClick={() => { navigate(studentRoutes.profile); setMobileNav(false); }}>
            <UserCheck size={19} />
            <span>الملف الشخصي</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="mini-profile">
            <div className="avatar">{student.full_name_ar.slice(0, 1)}</div>
            <span><b>{student.full_name_ar}</b><small>الفرقة {student.level}</small></span>
          </div>
          <div className="privacy-badge"><ShieldCheck size={15} /> بياناتك محمية</div>
        </div>
      </aside>
      <div className="main-column">
        <AppHeader title={tab === 'dashboard' ? 'الرئيسية' : tab === 'attendance' ? 'سجل الحضور' : tab === 'addSubjects' ? 'إضافة مواد دراسية' : 'الملف الشخصي'} subtitle={`أهلًا بك، ${student.full_name_ar.split(' ')[0]}`} onLogout={onLogout} onMenu={() => setMobileNav((current) => !current)} />
        {tab === 'dashboard' && <StudentDashboard student={student} notify={notify} onOpenAttendance={() => navigate(studentRoutes.attendance)} />}
        {tab === 'attendance' && <StudentAttendance student={student} />}
        {tab === 'addSubjects' && <StudentAddSubjects student={student} notify={notify} />}
        {tab === 'profile' && <StudentProfile student={student} user={user} notify={notify} />}
        <SiteFooter />
      </div>
      <nav className="mobile-bottom-nav" aria-label="التنقل السريع">
        <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => navigate(studentRoutes.dashboard)}>
          <LayoutDashboard size={20} />
          <span>الرئيسية</span>
        </button>
        <button className={tab === 'attendance' ? 'active' : ''} onClick={() => navigate(studentRoutes.attendance)}>
          <CalendarCheck size={20} />
          <span>الحضور</span>
        </button>
        <button className={tab === 'profile' ? 'active' : ''} onClick={() => navigate(studentRoutes.profile)}>
          <UserCheck size={20} />
          <span>الملف</span>
        </button>
      </nav>
    </div>
  );
}

function SidebarBrand() { return <div className="sidebar-brand"><div className="brand-mark">ح</div><div><strong>حضور</strong><span>التربية الموسيقية</span></div></div>; }

// فوتر حقوق النشر — إنجليزي فقط (المعيار العالمي المعتمد)
function SiteFooter() {
  return <footer className="site-footer">
    <p dir="ltr">© 2026 Dr. Peter Ehab Atef Ezzat. All rights reserved.</p>
  </footer>;
}

function StudentDashboard({ student, notify, onOpenAttendance }: { student: Student; notify: (message: string, type?: 'success' | 'error' | 'info') => void; onOpenAttendance: () => void }) {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [activeSessions, setActiveSessions] = useState<LectureSession[]>([]);
  const [logs, setLogs] = useState<AttendanceLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const [subjectResult, sessionResult, attendanceResult] = await Promise.all([getStudentSubjects(student.id), getActiveSessions(), getStudentAttendance(student.id)]);
    if (subjectResult.error || sessionResult.error || attendanceResult.error) notify('تعذر تحديث بعض بيانات لوحة الطالب.', 'error');
    setSubjects(subjectResult.data);
    setActiveSessions(sessionResult.data.filter((session) => subjectResult.data.some((subject) => subject.id === session.subject_id)));
    setLogs(attendanceResult.data);
    setLoading(false);
  }, [notify, student.id]);
  // ابقِ حالة الجلسات متزامنة: لو بدأ الإدمن الإشارة الصوتية بعد فتح الطالب
  // للوحة، يظهر زر تسجيل الحضور بالصوت دون الحاجة لإعادة تحميل الصفحة.
  useEffect(() => {
    void load();
    const refresh = window.setInterval(() => { void load(); }, 6000);
    return () => { window.clearInterval(refresh); };
  }, [load]);

  async function handleCheckIn(session: LectureSession) {
    if (!supportsPasskeys()) {
      return notify('جهازك لا يدعم تسجيل الحضور بالبصمة. استخدم زر "تسجيل الحضور بالصوت" أسفل بطاقة المحاضرة بعد تشغيل الإشارة من المحاضر.', 'error');
    }
    setCheckingId(session.id);
    try {
      const location = await readCurrentLocation();
      const options = await insforge.functions.invoke<Record<string, unknown>>('webauthn-auth-options', { body: { student_id: student.id } });
      if (options.error || !options.data) throw new Error(errorMessage(options.error, 'تعذر بدء التحقق من الجهاز.'));
      const assertion = await startAuthentication({ optionsJSON: options.data as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
      const result = await checkIn({ sessionId: session.id, latitude: location.latitude, longitude: location.longitude, webauthnAssertion: assertion });
      if (result.error) throw new Error(errorMessage(result.error, 'تعذر تسجيل الحضور.'));
      notify('تم تسجيل حضورك بنجاح.', 'success');
      await load();
    } catch (error) { notify(userFacingDeviceError(error, 'تعذر تسجيل الحضور. حاول مرة أخرى.'), 'error'); }
    setCheckingId(null);
  }
  async function setupPasskey() {
    if (!supportsPasskeys()) return notify('افتح النظام من هاتف حديث يدعم البصمة أو Face ID.', 'error');
    setPasskeyBusy(true);
    try {
      const options = await insforge.functions.invoke<Record<string, unknown>>('webauthn-register-options', { body: { student_id: student.id } });
      if (options.error || !options.data) throw new Error(errorMessage(options.error, 'تعذر بدء تسجيل مفتاح الجهاز.'));
      const credential = await startRegistration({ optionsJSON: options.data as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'] });
      const result = await insforge.functions.invoke('webauthn-register-verify', { body: { credential } });
      if (result.error) throw new Error(errorMessage(result.error));
      notify('تم ربط مفتاح جهازك بنجاح.', 'success');
    } catch (error) { notify(userFacingDeviceError(error, 'تعذر تسجيل مفتاح الجهاز.'), 'error'); }
    setPasskeyBusy(false);
  }
  const attended = logs.length;
  const [lawStatus, setLawStatus] = useState<MyAttendanceStatusRow[]>([]);
  useEffect(() => { getMyAttendanceStatus().then((result) => setLawStatus(result.data)); }, []);
  // الإشعارات الرسمية (إنذار أول/ثانٍ/حرمان) تصل هنا تلقائيًا لحظة إصدارها.
  const [lawNotifs, setLawNotifs] = useState<LawNotification[]>([]);
  const loadLawNotifs = useCallback(async () => { const { data } = await getMyLawNotifications(); setLawNotifs(data); }, []);
  useEffect(() => { void loadLawNotifs(); }, [loadLawNotifs]);
  const bannedSubjects = lawStatus.filter((row) => row.is_banned);
  const warnedSubjects = lawStatus.filter((row) => !row.is_banned && row.warning_count > 0);
  const lowSubjects = lawStatus.filter((row) => !row.is_banned && row.warning_count === 0 && row.attendance_percent < 75);
  return <main className="content-area"><div className="welcome-banner"><div><span className="eyebrow">لوحة الطالب</span><h2>أهلًا يا {student.full_name_ar.split(' ')[0]} <span>♪</span></h2><p>تابع محاضراتك وسجل حضورك بسهولة وأمان.</p></div><div className="banner-illustration"><div className="music-note note-one">♪</div><div className="music-note note-two">♫</div><div className="banner-circle" /></div></div><div className="stats-grid"><StatCard icon={<CalendarCheck />} label="إجمالي الحضور" value={String(attended)} hint="محاضرة مسجلة" tone="green" /><StatCard icon={<Clock3 />} label="جلسات متاحة الآن" value={String(activeSessions.length)} hint="بانتظار تسجيلك" tone="orange" /><StatCard icon={<GraduationCap />} label="المواد المسجلة" value={String(subjects.length)} hint={TERM_LABELS[student.term]} tone="blue" /></div>{bannedSubjects.length > 0 && <div className="status-alert law-ban-alert"><div className="alert-icon"><AlertTriangle size={21} /></div><div><b>تنبيه حرمان — {bannedSubjects.map((row) => row.subject_name).join('، ')}</b><p>{LAW_TEXT}</p></div></div>}{warnedSubjects.length > 0 && <div className="status-alert"><div className="alert-icon"><AlertTriangle size={21} /></div><div><b>إنذار حضور — {warnedSubjects.map((row) => `${row.subject_name} (${row.attendance_percent}%)`).join('، ')}</b><p>نسبة حضورك أقل من المطلوب (75%). انتظامك ضروري لتجنب الحرمان وفقًا للمادة ٣٥.</p></div></div>}{lowSubjects.length > 0 && <div className="status-alert"><div className="alert-icon"><Clock3 size={21} /></div><div><b>نسبة حضور منخفضة — {lowSubjects.map((row) => `${row.subject_name} (${row.attendance_percent}%)`).join('، ')}</b><p>حضورك أقل من 75% المطلوبة. انتظم في المحاضرات القادمة.</p></div></div>}
  {lawNotifs.filter((row) => !row.read_at).length > 0 && <section className="section-block"><div className="section-heading"><div><span className="eyebrow">إشعارات رسمية</span><h3>إنذارات وحرمان ({lawNotifs.filter((row) => !row.read_at).length} جديد)</h3></div><button className="text-button" onClick={async () => { await markMyLawNotificationsRead(); setLawNotifs((rows) => rows.map((row) => (row.read_at ? row : { ...row, read_at: new Date().toISOString() }))); }}>تم الاطلاع</button></div><div className="table-card">{lawNotifs.filter((row) => !row.read_at).map((row) => <div className="pending-row" key={row.id}><div className="avatar small-avatar">{row.kind === 'deprivation' ? '!' : '⚠'}</div><div><b>{row.title}</b><small>{row.body}</small><small>{new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.created_at))}</small></div></div>)}</div></section>}{student.status !== 'approved' && <div className="status-alert"><div className="alert-icon"><Clock3 size={21} /></div><div><b>حسابك {STATUS_LABELS[student.status]}</b><p>{student.status === 'pending' ? 'يمكنك تجهيز ملفك الآن، وسيُفتح تسجيل الحضور بعد مراجعة الإدمن لبياناتك.' : 'يرجى مراجعة إدارة القسم لمعرفة حالة الحساب.'}</p></div></div>}{activeSessions.length > 0 && <section className="section-block"><div className="section-heading"><div><span className="eyebrow">متاح الآن</span><h3>محاضرات مفتوحة للتسجيل</h3></div><button className="text-button" onClick={onOpenAttendance}>عرض السجل <ArrowLeft size={15} /></button></div><div className="session-grid">{activeSessions.map((session) => <div className="session-card" key={session.id}><div className="session-top"><span className="live-dot"><span /> مباشر</span><span className="session-time">{new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit' }).format(new Date(session.opened_at))}</span></div><h4>{session.subject?.name_ar ?? 'مادة دراسية'}</h4><p><MapPin size={15} /> البصمة + الموقع داخل الكلية، أو الصوت داخل القاعة</p><button className="primary-button full" disabled={checkingId === session.id || student.status !== 'approved'} onClick={() => void handleCheckIn(session)}>{checkingId === session.id ? <><span className="button-spinner" /> جارٍ التحقق…</> : <><Fingerprint size={17} /> تسجيل الحضور بالبصمة</>}</button>{session.is_attendance_active && student.status === 'approved' && <StudentAudioReceiver sessionId={session.id} notify={notify} onSuccess={() => void load()} />}</div>)}</div></section>}{activeSessions.length === 0 && <section className="empty-panel"><div className="empty-icon"><CalendarCheck size={27} /></div><h3>لا توجد محاضرات مفتوحة الآن</h3><p>سيظهر زر تسجيل الحضور هنا فور بدء الإدمن لمحاضرة تخص موادك.</p></section>}<section className="section-block"><div className="section-heading"><div><span className="eyebrow">أمان الحساب</span><h3>مفتاح جهازك</h3></div></div><div className="security-panel"><div className="security-symbol"><Fingerprint size={28} /></div><div><b>استخدم بصمة هاتفك أو جهازك اللوحي لتسجيل الحضور</b><p>لا نرى بصمتك ولا نخزن صورة وجهك. يحتفظ جهازك بالمفتاح الخاص، ويحتفظ النظام بمفتاح عام مشفّر فقط. الأجهزة اللوحية مدعومة بالكامل.</p></div><button className="secondary-button" onClick={() => void setupPasskey()} disabled={passkeyBusy}>{passkeyBusy ? 'جارٍ الربط…' : 'ربط الجهاز'}</button></div></section></main>;
}

function StatCard({ icon, label, value, hint, tone }: { icon: React.ReactNode; label: string; value: string; hint: string; tone: string }) { return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{hint}</small></div></div>; }

function StudentAttendance({ student }: { student: Student }) {
  const [logs, setLogs] = useState<AttendanceLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [lawStatus, setLawStatus] = useState<MyAttendanceStatusRow[]>([]);
  useEffect(() => {
    getStudentAttendance(student.id).then((result) => { setLogs(result.data); setLoading(false); });
    getMyAttendanceStatus().then((result) => setLawStatus(result.data));
  }, [student.id]);
  const bannedSubjects = lawStatus.filter((row) => row.is_banned);
  const warnedSubjects = lawStatus.filter((row) => !row.is_banned && row.warning_count > 0);
  const lowSubjects = lawStatus.filter((row) => !row.is_banned && row.warning_count === 0 && row.attendance_percent < 75);
  return <main className="content-area"><div className="page-intro"><div><span className="eyebrow">سجل محاضراتك</span><h2>سجل الحضور</h2><p>يعرض هذا السجل حالة حضورك فقط.</p></div></div>
        {bannedSubjects.length > 0 && <div className="status-alert law-ban-alert"><div className="alert-icon"><AlertTriangle size={21} /></div><div><b>تنبيه حرمان — {bannedSubjects.map((row) => row.subject_name).join('، ')}</b><p>{LAW_TEXT}</p></div></div>}
        {warnedSubjects.length > 0 && <div className="status-alert"><div className="alert-icon"><AlertTriangle size={21} /></div><div><b>إنذار حضور — {warnedSubjects.map((row) => `${row.subject_name} (${row.attendance_percent}%)`).join('، ')}</b><p>نسبة حضورك في هذه المادة أقل من الحد المطلوب (75%). انتظامك في المحاضرات القادمة ضروري لتجنب الحرمان وفقًا للمادة ٣٥.</p></div></div>}
        {lowSubjects.length > 0 && <div className="status-alert"><div className="alert-icon"><Clock3 size={21} /></div><div><b>نسبة حضور منخفضة — {lowSubjects.map((row) => `${row.subject_name} (${row.attendance_percent}%)`).join('، ')}</b><p>حضورك أقل من 75% المطلوبة في هذه المادة. انتظم في المحاضرات القادمة.</p></div></div>}
        <div className="table-card">

    <div className="table-card-head"><h3>المحاضرات المسجلة</h3><span>{logs.length} سجل</span></div>{loading ? <InlineLoading /> : logs.length === 0 ? <EmptyState title="لا توجد سجلات حضور بعد" description="ستظهر المحاضرات التي تسجل حضورك بها هنا." /> : <div className="responsive-table"><table><thead><tr><th>المادة</th><th>التاريخ</th><th>الوقت</th><th>الحالة</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id}><td><b>{log.session?.subject?.name_ar ?? 'محاضرة'}</b></td><td>{new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(new Date(log.checked_in_at))}</td><td>{new Intl.DateTimeFormat('ar-EG', { timeStyle: 'short' }).format(new Date(log.checked_in_at))}</td><td><span className="attendance-badge present"><Check size={14} /> حضور</span></td></tr>)}</tbody></table></div>}</div><div className="notice-box"><AlertTriangle size={19} /><div><b>لماذا هذا السجل مهم؟</b><p>{LAW_TEXT}</p></div></div></main>;
}

function StudentAddSubjects({ student, notify }: { student: Student; notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  // مواد فرقة الطالب فقط: لا تظهر له مواد أي مستوى آخر (بنفس قاعدة النموذج الرسمي).
  const [level] = useState<number>(student.level);
  const [term] = useState<AcademicTerm>('term1'); // الترم الأول فقط مفعّل حاليًا
  const step2Ready = Number.isFinite(level) && level >= 1 && level <= 4;
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [mySubjects, setMySubjects] = useState<Subject[]>([]);
  const [requests, setRequests] = useState<MyAddSubjectRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadRequests = useCallback(async () => {
    const [reqResult, enrolledResult] = await Promise.all([getMyAddSubjectRequests(), getStudentSubjects(student.id)]);
    setRequests(reqResult.data ?? []);
    setMySubjects(enrolledResult.data ?? []);
  }, [student.id]);
  useEffect(() => { void loadRequests(); }, [loadRequests]);

  async function loadSubjects() {
    setLoading(true);
    setSelected([]);
    const result = await getAddableSubjects(level, term);
    setLoading(false);
    if (result.error) return notify(errorMessage(result.error, 'تعذر تحميل المواد المتاحة.'), 'error');
    setSubjects(result.data);
    if (!result.data.length) notify('لا توجد مواد متاحة لهذا المستوى في الترم الأول حاليًا.', 'info');
  }

  async function submitRequests() {
    if (!selected.length) return notify('اختر مادة واحدة على الأقل.', 'error');
    if (!window.confirm(`إرسال طلب إضافة ${selected.length} مادة للإدارة؟\nستحتاج موافقة أدمن المادة (الدكتور) أو المشرف العام قبل تفعيل الحضور.`)) return;
    setSubmitting(true);
    const result = await requestAddSubjects(selected);
    setSubmitting(false);
    if (result.error) return notify(errorMessage(result.error, 'تعذر إرسال الطلب.'), 'error');
    notify(result.data === 0 ? 'كل المواد المختارة مضافة أو معلقة بالفعل — لا جديد.' : `تم إرسال ${result.data} طلب مزال — بانتظار موافقة الإدارة.`, 'success');
    setSelected([]);
    void loadRequests();
  }

  // المادة المسجلة فعليًا (نشطة) لا تعرض — المسجلة سابقاً مستثناة من القائمة.
  const enrolledIds = new Set(mySubjects.map((subject) => subject.id));
  const pendingIds = new Set(requests.filter((request) => request.status === 'pending').map((request) => request.subject_id));
  const filteredSubjects = subjects.filter((subject) => !enrolledIds.has(subject.id));
  const allSelected = filteredSubjects.length > 0 && selected.length === filteredSubjects.length;

  return <main className="content-area">
    <div className="page-intro">
      <div>
        <span className="eyebrow">اعتماد حسابك مطلوب</span>
        <h2>إضافة مواد دراسية</h2>
        <p>اختر المستوى والترم ثم المواد التي تريد إضافتها للمواد المسجلة بهذا الترم — بعد موافقة الإدارة تُفعّل فورًا بنفس نظام الحضور والدرجات.</p>
      </div>
    </div>
    {student.status !== 'approved' && (
      <div className="status-alert">
        <div className="alert-icon"><Clock3 size={21} /></div>
        <div><b>حسابك {STATUS_LABELS[student.status]}</b><p>ستفتح هذه الميزة بعد اعتماد الإدمن لحسابك.</p></div>
      </div>
    )}
    {student.term !== 'term1' && (
      <div className="notice-box">
        <AlertTriangle size={19} />
        <div><b>الترم الحالي غير الأول</b><p>حاليًا الترم الأول فقط مفعّل لإضافة المواد — ستنفتح باقي الترمات لاحقاً.</p></div>
      </div>
    )}

    <div className="table-card">
      <div className="table-card-head">
        <div><span className="eyebrow">اختيار المواد</span><h3>١. اختر المستوى ثم الترم ثم ٢. المواد المتاحة</h3></div>
      </div>
      <div style={{ padding: '0 18px 18px' }}>
        <div className="two-fields">
          <label>المستوى (فرقتك)
            <select value={level} disabled>
              <option value={1}>الفرقة الأولى</option>
              <option value={2}>الفرقة الثانية</option>
              <option value={3}>الفرقة الثالثة</option>
              <option value={4}>الفرقة الرابعة</option>
            </select>
          </label>
          <label>الترم
            <select value={term} disabled>
              <option value="term1">الترم الأول (المفعّل)</option>
              <option value="term2">الترم الثاني (غير مفعّل)</option>
              <option value="summer">الترم الصيفي (غير مفعّل)</option>
            </select>
          </label>
        </div>
        <button className="primary-button full" style={{ marginTop: 12 }} disabled={!step2Ready || loading} onClick={() => void loadSubjects()}>
          {loading ? <><span className="button-spinner" /> جارٍ التحميل…</> : <>عرض المواد المتاحة <ArrowLeft size={16} /></>}
        </button>
      </div>
    </div>

    {filteredSubjects.length > 0 && (
      <div className="table-card">
        <div className="table-card-head">
          <div><span className="eyebrow">الخطوة الأخيرة</span><h3>المواد المتاحة ({filteredSubjects.length})</h3></div>
          <button
            type="button"
            className={`select-all-pill ${allSelected ? 'all-active' : ''}`}
            onClick={() => setSelected(allSelected ? [] : filteredSubjects.map((subject) => subject.id))}
          >
            <span className="pill-check-indicator">
              {allSelected ? <Check size={11} strokeWidth={3} /> : selected.length > 0 ? <span className="pill-dash" /> : null}
            </span>
            <span>{allSelected ? 'إلغاء التحديد' : 'تحديد الكل'}</span>
          </button>
        </div>
        <div style={{ padding: '0 18px 18px' }}>
          <div className="subject-picker">
            {filteredSubjects.map((subject) => {
              const pending = pendingIds.has(subject.id);
              return (
                <label key={subject.id} className={`subject-option ${selected.includes(subject.id) ? 'selected' : ''} ${pending ? 'pending' : ''}`}>
                  <input
                    type="checkbox"
                    disabled={pending}
                    checked={selected.includes(subject.id)}
                    onChange={() => setSelected((current) => current.includes(subject.id) ? current.filter((id) => id !== subject.id) : [...current, subject.id])}
                  />
                  <span className="check-box">{selected.includes(subject.id) && <Check size={15} />}</span>
                  <span><b>{subject.name_ar}</b><small>{pending ? 'طلب معلّق بانتظار الموافقة' : `الفرقة ${subject.level} · درجة قصوى ${subject.max_grade}`}</small></span>
                </label>
              );
            })}
          </div>
          <button className="primary-button full" style={{ marginTop: 12 }} disabled={submitting || !selected.length || student.status !== 'approved'} onClick={() => void submitRequests()}>
            {submitting ? <><span className="button-spinner" /> جارٍ الإرسال…</> : <>إرسال طلب الإضافة ({selected.length} مادة) <ArrowLeft size={16} /></>}
          </button>
        </div>
      </div>
    )}

    {requests.length > 0 && (
      <div className="table-card">
        <div className="table-card-head"><div><span className="eyebrow">سجل الطلبات</span><h3>طلباتي السابقة</h3></div></div>
        <div className="responsive-table">
          <table>
            <thead><tr><th>المادة</th><th>التاريخ</th><th>الحالة</th></tr></thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.request_id}>
                  <td><b>{request.subject_name}</b></td>
                  <td>{new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(request.requested_at))}</td>
                  <td>
                    {request.status === 'pending' ? <span className="status-pill pending">بانتظار الموافقة</span>
                      : request.status === 'approved' ? <span className="status-pill approved">تمت الموافقة</span>
                      : <span className="status-pill rejected">مرفوض</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )}

    <div className="table-card">
      <div className="table-card-head"><div><span className="eyebrow">الوضع الحالي</span><h3>المواد المسجلة ({mySubjects.length})</h3></div></div>
      <div className="subject-list">
        {mySubjects.map((subject) => <div className="subject-row" key={subject.id}><div className="subject-number">{subject.level}</div><div><b>{subject.name_ar}</b><small>مسجلة — لا تُعاد</small></div></div>)}
        {!mySubjects.length && <EmptyState title="لا مواد مسجلة بعد" description="ستظهر المواد التي تسجتها أو تُوافق عليها الإدارة هنا." />}
      </div>
    </div>
  </main>;
}

function StudentProfile({ student, user, notify }: { student: Student; user: User; notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [resetBusy, setResetBusy] = useState(false);
  const [changeBusy, setChangeBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [arName, setArName] = useState(student.full_name_ar);
  const [enName, setEnName] = useState(student.full_name_en);
  const [saveBusy, setSaveBusy] = useState(false);

  const [resetRequest, setResetRequest] = useState<any>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPasswordSelf, setNewPasswordSelf] = useState('');
  const [confirmPasswordSelf, setConfirmPasswordSelf] = useState('');

  useEffect(() => {
    insforge.database.from('password_reset_requests')
      .select('*')
      .eq('student_id', student.id)
      .in('status', ['pending', 'approved'])
      .eq('new_password_set', false)
      .order('requested_at', { ascending: false })
      .limit(1)
      .then(res => {
        if (res.data && res.data.length > 0) setResetRequest(res.data[0]);
      });
  }, [student.id]);

  async function requestReset() {
    setResetBusy(true);
    const res = await insforge.functions.invoke('request-password-reset', { body: {} });
    if (res.error) notify(errorMessage(res.error, 'حدث خطأ'), 'error');
    else {
      notify('تم إرسال الطلب بنجاح', 'success');
      setResetRequest({ status: 'pending' });
    }
    setResetBusy(false);
  }

  const passwordStrong = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(newPassword);

  async function applyNewPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!passwordStrong) return notify('كلمة المرور غير مستوفية للشروط', 'error');
    if (newPassword !== confirmPassword) return notify('كلمتا المرور غير متطابقتين', 'error');
    
    setResetBusy(true);
    const authRes = await insforge.functions.invoke('student-update-password', { body: { password: newPassword, request_id: resetRequest.id } });
    if (authRes.error) {
      notify(errorMessage(authRes.error, 'تعذر تحديث كلمة المرور'), 'error');
      setResetBusy(false);
      return;
    }
    
    setResetRequest(null);
    setNewPassword('');
    setConfirmPassword('');
    notify('تم تغيير كلمة المرور بنجاح!', 'success');
    setResetBusy(false);
  }

  const passwordStrongSelf = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(newPasswordSelf);

  async function changeOwnPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!passwordStrongSelf) return notify('كلمة المرور غير مستوفية للشروط', 'error');
    if (newPasswordSelf !== confirmPasswordSelf) return notify('كلمتا المرور غير متطابقتين', 'error');
    setChangeBusy(true);
    const res = await insforge.functions.invoke('student-change-own-password', {
      body: { currentPassword: currentPassword || undefined, newPassword: newPasswordSelf },
    });
    if (res.error) {
      notify(errorMessage(res.error, 'تعذر تغيير كلمة المرور'), 'error');
      setChangeBusy(false);
      return;
    }
    setCurrentPassword('');
    setNewPasswordSelf('');
    setConfirmPasswordSelf('');
    notify('تم تغيير كلمة المرور بنجاح!', 'success');
    setChangeBusy(false);
  }

  async function saveName() {
    const arWords = arName.trim().split(/\s+/).filter(Boolean);
    const enWords = enName.trim().split(/\s+/).filter(Boolean);
    if (arWords.length < 4 || !/^[\u0600-\u065F\u066A-\u06D2\s]+$/.test(arName.replace(/\s/g, ''))) return notify('يجب إدخال الاسم الرباعي باللغة العربية صحيحًا', 'error');
    if (enWords.length < 4 || !/^[A-Za-z\s]+$/.test(enName.replace(/\s/g, ''))) return notify('يجب إدخال الاسم الرباعي باللغة الإنجليزية صحيحًا', 'error');
    setSaveBusy(true);
    const res = await database.from('students').update({ full_name_ar: arName.trim(), full_name_en: enName.trim() }).eq('id', student.id);
    setSaveBusy(false);
    if (res.error) notify(errorMessage(res.error, 'تعذر الحفظ'), 'error');
    else {
      notify('تم تحديث الاسم بنجاح. قد تحتاج لتحديث الصفحة.', 'success');
      setEditing(false);
    }
  }

  const [subjects, setSubjects] = useState<Subject[]>([]);
  useEffect(() => { getStudentSubjects(student.id).then((result) => setSubjects(result.data)); }, [student.id]);
  return <main className="content-area"><div className="page-intro"><div><span className="eyebrow">بيانات الحساب</span><h2>الملف الشخصي</h2><p>يمكنك مراجعة وتعديل بياناتك الأساسية من هنا.</p></div></div><div className="profile-grid"><section className="table-card profile-card"><div className="profile-header"><div className="large-avatar">{student.full_name_ar.slice(0, 1)}</div><div><h3>{student.full_name_ar}</h3><span>{student.email}</span></div><span className={`status-pill ${student.status}`}>{STATUS_LABELS[student.status]}</span></div><div className="detail-grid">
  {editing ? (
    <div className="stack-form full-width-field">
      <label>الاسم بالعربية<input value={arName} onChange={e => setArName(e.target.value)} /></label>
      <label>الاسم بالإنجليزية<input value={enName} onChange={e => setEnName(e.target.value)} dir="ltr" /></label>
      <div className="form-actions">
        <button className="primary-button" disabled={saveBusy} onClick={() => void saveName()}>حفظ</button>
        <button className="text-button" onClick={() => setEditing(false)}>إلغاء</button>
      </div>
    </div>
  ) : (
    <>
      <Detail label="الاسم بالعربية" value={student.full_name_ar} />
      <Detail label="الاسم بالإنجليزية" value={student.full_name_en} />
      <div className="full-width-field"><button className="text-button" onClick={() => setEditing(true)}>تعديل الاسم</button></div>
    </>
  )}
  <Detail label="البريد الإلكتروني" value={user.email ?? student.email} ltr /><Detail label="الفرقة" value={`الفرقة ${student.level}`} /><Detail label="الترم" value={TERM_LABELS[student.term]} /><Detail label="الرقم القومي" value={`••••••••${student.national_id.slice(-4)}`} ltr /></div></section><section className="table-card"><div className="table-card-head"><h3>المواد المسجلة</h3><span>{subjects.length} مواد</span></div><div className="subject-list">{subjects.map((subject) => <div className="subject-row" key={subject.id}><div className="subject-number">{subject.level}</div><div><b>{subject.name_ar}</b><small>الدرجة القصوى محفوظة لدى الإدمن</small></div></div>)}</div></section><EnrollmentStatus studentId={student.id} /></div>
  <section className="table-card reset-card">
    <div className="security-symbol"><LockKeyhole size={23} /></div>
    <div><h3>إعادة تعيين كلمة المرور</h3><p>يمكنك إرسال طلب إلى الإدمن. الحد الأقصى 3 طلبات في الترم الواحد.{student.password_reset_requests_used ? ` استخدمت ${student.password_reset_requests_used} من 3.` : ''}</p></div>
    
    {resetRequest?.status === 'pending' ? (
      <div className="status-alert"><p>طلبك قيد المراجعة من الإدمن...</p></div>
    ) : resetRequest?.status === 'approved' ? (
      <form className="stack-form reset-form" onSubmit={applyNewPassword}>
        <div className="status-alert"><p>تمت الموافقة! أدخل كلمة المرور الجديدة أدناه.</p></div>
        <label>كلمة المرور الجديدة<PasswordField value={newPassword} onChange={setNewPassword} required minLength={8} />{newPassword && <small className={passwordStrong ? 'valid-hint' : 'error-hint'}>{passwordStrong ? 'مستوفية للشروط' : 'يجب أن تشمل حرفًا كبيرًا وصغيرًا ورقمًا ورمزًا'}</small>}</label>
        <label>تأكيد كلمة المرور<PasswordField value={confirmPassword} onChange={setConfirmPassword} required minLength={8} /></label>
        <button className="primary-button" type="submit" disabled={resetBusy || !passwordStrong}>{resetBusy ? 'جارٍ الحفظ...' : 'تأكيد وحفظ'}</button>
      </form>
    ) : (
      <button className="secondary-button" disabled={resetBusy} onClick={() => void requestReset()}>{resetBusy ? 'جارٍ الإرسال...' : 'إرسال طلب'}</button>
    )}
  </section>
  <section className="table-card reset-card">
    <div className="security-symbol"><LockKeyhole size={23} /></div>
    <div><h3>تغيير كلمة المرور مباشرة</h3><p>يمكنك تغيير كلمة المرور حالًا من هنا دون انتظار موافقة الإدمن.{student.password_change_direct_used ? ` استخدمت ${student.password_change_direct_used} من 3 مرات في الترم.` : ` متبقٍ لك ${3 - (student.password_change_direct_used ?? 0)} من 3 مرات في الترم.`}</p></div>
    <form className="stack-form reset-form" onSubmit={changeOwnPassword}>
      <label>كلمة المرور الحالية<PasswordField value={currentPassword} onChange={setCurrentPassword} placeholder="••••••••" autoComplete="current-password" /></label>
      <label>كلمة المرور الجديدة<PasswordField value={newPasswordSelf} onChange={setNewPasswordSelf} required minLength={8} />{newPasswordSelf && <small className={passwordStrongSelf ? 'valid-hint' : 'error-hint'}>{passwordStrongSelf ? 'مستوفية للشروط' : 'يجب أن تشمل حرفًا كبيرًا وصغيرًا ورقمًا ورمزًا'}</small>}</label>
      <label>تأكيد كلمة المرور الجديدة<PasswordField value={confirmPasswordSelf} onChange={setConfirmPasswordSelf} required minLength={8} /></label>
      <button className="primary-button" type="submit" disabled={changeBusy || !passwordStrongSelf || newPasswordSelf !== confirmPasswordSelf || (student.password_change_direct_used ?? 0) >= 3}>{changeBusy ? 'جارٍ الحفظ...' : 'حفظ كلمة المرور'}</button>
      {(student.password_change_direct_used ?? 0) >= 3 && <div className="status-alert"><p>استنفدت مرات التغيير المباشر (3/3) لهذا الترم. أرسل طلب إعادة تعيين أو راجع الإدارة.</p></div>}
    </form>
  </section>
</main>;
}

function Detail({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) { return <div className="detail"><span>{label}</span><b dir={ltr ? 'ltr' : undefined}>{value}</b></div>; }

// ─── صلاحيات اللوحة: المشرف العام يرى كل شيء، وأدمن المادة يرى نطاقه فقط ───
const SUPER_ADMIN_TABS: AdminTab[] = ['overview', 'students', 'passwords', 'whitelist', 'sessions', 'grades', 'addSubjectsQueue', 'subjectAdmins', 'promotion', 'repeaters', 'law35', 'audit', 'settings'];

/** التبويبات المسموح بها فعليًا لهذا الحساب (نفس ترتيب القائمة الأصلي). */
function allowedAdminTabs(scope: AdminScope): AdminTab[] {
  if (scope.is_super) return SUPER_ADMIN_TABS;
  const tabs: AdminTab[] = ['overview'];
  // «طلبات تسجيل الطلاب» لا تظهر إلا بمنحة صريحة من المشرف العام.
  if (scope.can_review_registrations) tabs.push('students');
  tabs.push('whitelist', 'sessions', 'grades', 'law35', 'settings');
  return tabs;
}

/** الفروق المسموح لأدمن المادة باختيارها في الفلاتر — مثبتة ولا يمكن تغييرها. */
function adminLevelOptions(scope: AdminScope | null | undefined): number[] {
  return scope && !scope.is_super && scope.levels.length ? scope.levels : [1, 2, 3, 4];
}

function AdminShell({ admin, path, navigate, notify, onLogout, theme, setTheme }: { admin: Admin; path: string; navigate: (path: string, replace?: boolean) => void; notify: (message: string, type?: 'success' | 'error' | 'info') => void; onLogout: () => void; theme?: 'modern' | 'classic'; setTheme?: (t: 'modern' | 'classic') => void }) {
  const tab = adminTabFromPath(path);
  const [mobileNav, setMobileNav] = useState(false);
  const [scope, setScope] = useState<AdminScope | null>(null);
  const [me, setMe] = useState<Admin>(admin);
  // تنبيه تلقائي: عدد إجراءات المادة ٣٥ المستحقة الآن — يُحدَّث كل دقيقة بدون أي تدخل.
  const [lawDue, setLawDue] = useState<LawDueSummary | null>(null);

  useEffect(() => {
    let disposed = false;
    getMyAdminScope().then(({ data, error }) => {
      if (disposed) return;
      if (error || !data) return notify(errorMessage(error, 'تعذر تحميل صلاحيات الحساب. حدِّث الصفحة.'), 'error');
      setScope(data);
      setMe((current) => ({ ...current, full_name: data.full_name || current.full_name }));
    });
    return () => { disposed = true; };
  }, [notify]);

  const allowedTabs = scope ? allowedAdminTabs(scope) : [];
  const allowedTabsKey = allowedTabs.join(',');
  // حماية التنقل: أي رابط لتبويب غير مسموح يرجع تلقائيًا للنظرة العامة.
  useEffect(() => {
    if (!scope) return;
    if (!allowedTabsKey.split(',').includes(tab)) navigate(adminRoutes.overview, true);
  }, [scope, tab, navigate, allowedTabsKey]);

  useEffect(() => {
    let disposed = false;
    const pull = async () => { const { data } = await getLawDueSummary(); if (!disposed && data) setLawDue(data); };
    void pull();
    const timer = window.setInterval(() => { void pull(); }, 60000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  const tabs: Array<{ id: AdminTab; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: 'overview', label: 'نظرة عامة', icon: <LayoutDashboard size={19} /> },
    { id: 'students', label: 'طلبات تسجيل الطلاب', icon: <Users size={19} /> },
    { id: 'passwords', label: 'طلبات تعيين المرور', icon: <LockKeyhole size={19} /> },
    { id: 'whitelist', label: 'الأرقام المسموح لها بالتسجيل', icon: <ClipboardList size={19} /> },
    { id: 'sessions', label: 'الجلسات والحضور', icon: <Activity size={19} /> },
    { id: 'grades', label: 'سجل الدرجات السري', icon: <BarChart3 size={19} /> },
    { id: 'addSubjectsQueue', label: 'طلبات إضافة المواد', icon: <UserPlus size={19} /> },
    { id: 'subjectAdmins', label: 'أدمن المواد', icon: <UserCheck size={19} /> },
    { id: 'promotion', label: 'ترقية المنتظمين', icon: <GraduationCap size={19} /> },
    { id: 'repeaters', label: 'مراجعة الراسبين', icon: <AlertTriangle size={19} /> },
    { id: 'law35', label: 'قانون الحضور ٣٥', icon: <ClipboardList size={19} />, badge: lawDue?.due_now ?? 0 },
    { id: 'audit', label: 'سجل العمليات', icon: <ShieldAlert size={19} /> },
    { id: 'settings', label: 'الإعدادات', icon: <Settings2 size={19} /> },
  ];
  if (!scope) return <LoadingScreen />;
  const isSuper = scope.is_super;
  const visibleTabs = tabs.filter((item) => allowedTabs.includes(item.id));
  return (
    <div className="app-layout admin-layout">
      <div className={`sidebar-backdrop ${mobileNav ? 'active' : ''}`} onClick={() => setMobileNav(false)} aria-hidden="true" />
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <SidebarBrand />
        <div className="admin-label"><ShieldCheck size={15} /> {isSuper ? 'لوحة الإدمن' : 'لوحة تحكم أدمن المادة'}</div>
        <nav>
          {visibleTabs.map((item) => (
            <button key={item.id} className={tab === item.id ? 'nav-active' : ''} onClick={() => { navigate(adminRoutes[item.id]); setMobileNav(false); }}>
              {item.icon}
              <span>{item.label}</span>
              {!!item.badge && <span className="nav-badge" title="إجراءات المادة ٣٥ المستحقة الآن">{item.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="mini-profile">
            <div className="avatar admin-avatar">{me.full_name.slice(0, 1)}</div>
            <span>
              <b>{me.full_name}</b>
              <small>{isSuper ? 'مدير النظام' : `أدمن ${scope.subject_names.join('، ') || 'مادة غير محددة'}`}</small>
            </span>
          </div>
          <div className="privacy-badge"><ShieldCheck size={15} /> {isSuper ? 'صلاحيات كاملة' : 'موادك ومستواك فقط'}</div>
        </div>
      </aside>
      <div className="main-column">
        <AppHeader title={tabs.find((item) => item.id === tab)?.label ?? ''} subtitle={`مرحبًا، ${me.full_name}`} onLogout={onLogout} onMenu={() => setMobileNav((current) => !current)} />
        {tab === 'overview' && <AdminOverview admin={me} scope={scope} notify={notify} onNavigate={(nextTab) => navigate(adminRoutes[nextTab])} />}
        {tab === 'students' && <AdminStudents scope={scope} notify={notify} />}
        {tab === 'passwords' && <AdminPasswords notify={notify} />}
        {tab === 'whitelist' && <AdminWhitelist scope={scope} notify={notify} />}
        {tab === 'sessions' && <AdminSessions admin={me} scope={scope} notify={notify} />}
        {tab === 'grades' && <AdminGrades scope={scope} notify={notify} />}
        {tab === 'addSubjectsQueue' && <AdminAddSubjectsQueue notify={notify} />}
        {tab === 'subjectAdmins' && <AdminSubjectAdmins notify={notify} />}
        {tab === 'promotion' && <BulkPromotionPanel notify={notify} />}
        {tab === 'repeaters' && <RepeaterReviewPanel notify={notify} />}
        {tab === 'law35' && <AdminAttendanceLaw scope={scope} notify={notify} />}
        {tab === 'audit' && (isSuper ? <AdminAuditLog notify={notify} /> : <main className="content-area"><div className="empty-panel"><div className="empty-icon"><ShieldAlert size={26} /></div><h3>سجل العمليات للمشرف العام فقط</h3><p>هذه الشاشة تعرض كل عمليات النظام وكل محاولات الدخول، ولا تُتاح لأدمن المادة.</p></div></main>)}
        {tab === 'settings' && (isSuper
          ? <AdminSettings admin={me} notify={notify} theme={theme} setTheme={setTheme} />
          : <AdminOwnSettings admin={me} scope={scope} notify={notify} onProfileSaved={(fullName) => setMe((current) => ({ ...current, full_name: fullName }))} />)}
        <SiteFooter />
      </div>
      <nav className="mobile-bottom-nav admin-bottom-nav" aria-label="التنقل السريع للإدمن">
        <button className={tab === 'overview' ? 'active' : ''} onClick={() => { navigate(adminRoutes.overview); setMobileNav(false); }}>
          <LayoutDashboard size={20} />
          <span>الرئيسية</span>
        </button>
        {allowedTabs.includes('students') && (
          <button className={tab === 'students' ? 'active' : ''} onClick={() => { navigate(adminRoutes.students); setMobileNav(false); }}>
            <Users size={20} />
            <span>الطلاب</span>
          </button>
        )}
        <button className={tab === 'sessions' ? 'active' : ''} onClick={() => { navigate(adminRoutes.sessions); setMobileNav(false); }}>
          <Activity size={20} />
          <span>الجلسات</span>
        </button>
        <button className={tab === 'grades' ? 'active' : ''} onClick={() => { navigate(adminRoutes.grades); setMobileNav(false); }}>
          <BarChart3 size={20} />
          <span>الدرجات</span>
        </button>
        <button className={mobileNav ? 'active' : ''} onClick={() => setMobileNav((prev) => !prev)}>
          <Menu size={20} />
          <span>القائمة</span>
        </button>
      </nav>
    </div>
  );
}

function AdminOverview({ admin, scope, notify, onNavigate }: { admin: Admin; scope: AdminScope; notify: (message: string, type?: 'success' | 'error' | 'info') => void; onNavigate: (tab: AdminTab) => void }) {
  const mayReview = scope.is_super || scope.can_review_registrations;
  const [students, setStudents] = useState<Student[]>([]);
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [logs, setLogs] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => { Promise.all([getStudents(), getAdminSessions()]).then(([studentsResult, sessionsResult]) => { setStudents(studentsResult.data); setSessions(sessionsResult.data); }); }, []);
  const pending = students.filter((item) => item.status === 'pending').length;
  const active = sessions.filter((item) => item.is_active).length;
  const approved = students.filter((item) => item.status === 'approved').length;
  useEffect(() => { database.from('attendance_logs').select('id,checked_in_at,student_id').order('checked_in_at', { ascending: false }).limit(5).then(({ data }) => setLogs((data as Array<Record<string, unknown>>) ?? [])); }, []);
  return <main className="content-area"><div className="admin-hero"><div><span className="eyebrow">ملخص النظام</span><h2>لوحة التحكم <em>في إيقاع واحد.</em></h2><p>{scope.is_super ? 'تابع اعتماد الطلاب، الجلسات المفتوحة، وسجل الحضور من مكان واحد.' : `نطاقك المحدد فقط: ${scope.subject_names.join('، ') || 'لا مواد مسندة'} — الفرقة ${scope.levels.join('، ') || '—'}، وبلا أي وصول لبقية المواد أو الفرق.`}</p></div><div className="admin-hero-icon"><BarChart3 size={50} strokeWidth={1.3} /></div></div><div className="stats-grid admin-stats"><StatCard icon={<Users />} label={scope.is_super ? 'إجمالي الطلاب' : 'طلاب موادك'} value={String(students.length)} hint={`${approved} حساب معتمد`} tone="green" />{mayReview ? <StatCard icon={<Clock3 />} label="حسابات معلقة" value={String(pending)} hint="تحتاج مراجعتك" tone="orange" /> : <StatCard icon={<ClipboardList />} label="الفرق المسؤول عنها" value={scope.levels.join('، ') || '—'} hint={scope.subject_names.join('، ') || 'بلا مواد'} tone="orange" />}<StatCard icon={<Activity />} label="جلسات نشطة" value={String(active)} hint="تسجل الآن" tone="blue" /><StatCard icon={<ShieldCheck />} label="حالة الحماية" value="مفعلة" hint="RLS + Passkeys" tone="purple" /></div><div className="dashboard-columns">{mayReview ? <section className="table-card"><div className="table-card-head"><div><span className="eyebrow">تحتاج انتباهك</span><h3>طلبات التسجيل</h3></div><button className="text-button" onClick={() => onNavigate('students')}>كل الطلاب <ArrowLeft size={15} /></button></div>{students.filter((item) => item.status === 'pending').slice(0, 4).map((item) => <div className="pending-row" key={item.id}><div className="avatar small-avatar">{item.full_name_ar.slice(0, 1)}</div><div><b>{item.full_name_ar}</b><small>الفرقة {item.level} · {item.national_id}</small></div><span className="status-pill pending">معلق</span></div>)}{!pending && <EmptyState title="لا توجد طلبات معلقة" description="جميع الحسابات تمت مراجعتها." />}</section> : <section className="table-card"><div className="table-card-head"><div><span className="eyebrow">نطاقك</span><h3>المواد المسندة إليك</h3></div></div><div className="pending-row"><div className="avatar small-avatar"><ClipboardList size={16} /></div><div><b>{scope.subject_names.join('، ') || 'لا مواد مسندة'}</b><small>الفرقة {scope.levels.join('، ') || '—'} · طلبات تسجيل الطلاب غير متاحة لحسابك</small></div></div></section>}<section className="table-card"><div className="table-card-head"><div><span className="eyebrow">الآن</span><h3>الجلسات الحالية</h3></div><button className="text-button" onClick={() => onNavigate('sessions')}>إدارة <ArrowLeft size={15} /></button></div>{sessions.filter((item) => item.is_active).slice(0, 3).map((session) => <div className="active-session-row" key={session.id}><span className="live-dot"><span /> مباشر</span><div><b>{session.subject?.name_ar}</b><small>بدأت {new Intl.DateTimeFormat('ar-EG', { timeStyle: 'short' }).format(new Date(session.opened_at))}</small></div><ChevronDown size={17} /></div>)}{!active && <EmptyState title="لا توجد جلسات مفتوحة" description="ابدأ جلسة جديدة من صفحة الجلسات." />}</section></div><div className="quick-actions">{mayReview && <button onClick={() => onNavigate('students')}><UserCheck size={20} /><span><b>مراجعة الطلبات</b><small>اعتماد حسابات الطلاب</small></span><ArrowLeft size={17} /></button>}<button onClick={() => onNavigate('sessions')}><Activity size={20} /><span><b>فتح محاضرة</b><small>بدء تسجيل حضور مباشر</small></span><ArrowLeft size={17} /></button><button onClick={() => onNavigate('grades')}><FileSpreadsheet size={20} /><span><b>تصدير الدرجات</b><small>إلى Google Sheets</small></span><ArrowLeft size={17} /></button></div>{logs.length > 0 && <div className="sr-only">آخر حضور: {String(logs[0].checked_in_at)} بواسطة {admin.email}</div>}</main>;
}

function AdminPasswords({ notify }: { notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [loading, setLoading] = useState(true);
  const [resetRequests, setResetRequests] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const resetResult = await insforge.database.from('password_reset_requests').select('*, students(full_name_ar, national_id)').eq('status', 'pending');
    setResetRequests(resetResult.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const [issued, setIssued] = useState<{ name: string; password: string } | null>(null);

  async function handleReset(requestId: string, approve: boolean) {
    const res = await insforge.functions.invoke('admin-reset-password', { body: { request_id: requestId, approve } });
    if (res.error) return notify(res.error.message || 'خطأ', 'error');
    notify(approve ? 'تمت الموافقة على طلب إعادة التعيين.' : 'تم رفض الطلب.', 'success');
    load();
  }

  // الحل الفعلي لطالب لا يستطيع الدخول أصلًا: الإدمن يولّد كلمة مرور جديدة
  // مرة واحدة، تظهر له هنا ليمليها على الطالب، ولا تُخزَّن أبدًا كنص صريح.
  async function issuePassword(req: any) {
    const name = req.students?.full_name_ar ?? 'الطالب';
    const { data, error } = await adminSetStudentPassword(req.student_id);
    if (error || !data) return notify(errorMessage(error, 'تعذر توليد كلمة مرور جديدة.'), 'error');
    setIssued({ name, password: data });
    notify('تم توليد كلمة مرور جديدة — أمِلها على الطالب الآن.', 'success');
    load();
  }

  return (
    <main className="content-area">
      <div className="page-intro">
        <div><span className="eyebrow">إدارة المستخدمين</span><h2>طلبات تعيين المرور</h2><p>راجع طلبات إعادة تعيين كلمة المرور المعلقة.</p></div>
        <button className="icon-button" onClick={() => void load()} title="تحديث"><RefreshCw size={17} /></button>
      </div>
      {issued && (
        <div className="table-card" style={{ borderColor: '#f59e0b' }}>
          <div className="table-card-head">
            <div><span className="eyebrow">تسليم يدوي</span><h3>كلمة مرور جديدة لـ {issued.name}</h3></div>
            <button className="text-button" onClick={() => setIssued(null)}>إغلاق</button>
          </div>
          <div style={{ padding: '0 18px 18px' }}>
            <div className="notice-box"><LockKeyhole size={19} /><div><b>أمِلها على الطالب الآن</b><p>هذه الكلمة تظهر مرة واحدة فقط ولا تُخزَّن في أي جدول (يُخزَّن الـ hash فقط). أعِد توليدها في أي وقت بزر «توليد كلمة مرور».</p></div></div>
            <div className="row-actions" style={{ marginTop: 10 }}>
              <input readOnly value={issued.password} dir="ltr" onFocus={(event) => event.currentTarget.select()} style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: 1, maxWidth: 260 }} />
              <button className="secondary-button" onClick={() => { void navigator.clipboard?.writeText(issued.password); notify('تم نسخ كلمة المرور.', 'success'); }}><Copy size={15} /> نسخ</button>
            </div>
          </div>
        </div>
      )}
      <div className="table-card">
        <div className="table-card-head">
          <div><span className="eyebrow">الطلبات</span><h3>طلبات إعادة تعيين المرور ({resetRequests.length})</h3></div>
        </div>
        {loading ? <InlineLoading /> : resetRequests.length === 0 ? <EmptyState title="لا توجد طلبات معلقة" description="لا يوجد طلاب يطلبون إعادة تعيين كلمة المرور حالياً." /> : (
          <div className="responsive-table">
            <table>
              <thead>
                <tr><th>الطالب</th><th>الرقم القومي</th><th>التاريخ</th><th>إجراء</th></tr>
              </thead>
              <tbody>
                {resetRequests.map((req: any) => (
                  <tr key={req.id}>
                    <td>{req.students?.full_name_ar}</td>
                    <td dir="ltr">{req.students?.national_id}</td>
                    <td>{new Date(req.requested_at).toLocaleDateString()}</td>
                    <td>
                      <div className="row-actions">
                        <button className="approve-button" onClick={() => void issuePassword(req)}><KeyRound size={15} /> توليد كلمة مرور</button>
                        <button className="reject-button" onClick={() => void handleReset(req.id, false)}><X size={15} /> رفض</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function AdminStudents({ scope, notify }: { scope: AdminScope; notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  // أدمن المادة: فروقه مثبتة — لو فرقة واحدة تُثبَّت الفلتر ولا يمكن تغييره.
  const lockedLevels = scope.is_super ? [] : scope.levels;
  const [students, setStudents] = useState<Student[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [levelFilter, setLevelFilter] = useState<number | ''>('');
  const [loading, setLoading] = useState(true);
  const [renameStudent, setRenameStudent] = useState<Student | null>(null);
  const [renameAr, setRenameAr] = useState('');
  const [renameEn, setRenameEn] = useState('');
  const [savingName, setSavingName] = useState(false);

  const load = useCallback(async () => { 
    setLoading(true); 
    const result = await getStudents();
    if (result.error) notify(errorMessage(result.error), 'error'); 
    setStudents(result.data || []); 
    setLoading(false); 
  }, [notify]);
  
  useEffect(() => { void load(); }, [load]);

  useEffect(() => { if (lockedLevels.length === 1) setLevelFilter(lockedLevels[0]); }, [lockedLevels.join(',')]);

  async function changeStatus(student: Student, status: 'approved' | 'rejected') { 
    const result = await updateStudentStatus(student.id, status); 
    if (result.error) return notify(errorMessage(result.error, 'تعذر تحديث حالة الحساب.'), 'error'); 
    notify(status === 'approved' ? 'تم اعتماد حساب الطالب.' : 'تم رفض الطلب.', 'success'); 
    void load(); 
  }
  
  const [purgingId, setPurgingId] = useState<string | null>(null);
  function openRename(student: Student) { setRenameStudent(student); setRenameAr(student.full_name_ar); setRenameEn(student.full_name_en); }
  async function saveRename() {
    if (!renameStudent) return;
    const ar = renameAr.trim().replace(/\s+/g, ' ');
    const en = renameEn.trim().replace(/\s+/g, ' ');
    const arWords = ar.split(/\s+/).filter(Boolean);
    const enWords = en.split(/\s+/).filter(Boolean);
    if (arWords.length < 4 || !/^[\u0600-\u065F\u066A-\u06D2\s]+$/.test(ar.replace(/\s/g, ''))) return notify('يجب إدخال الاسم الرباعي باللغة العربية صحيحًا', 'error');
    if (enWords.length < 4 || !/^[A-Za-z\s]+$/.test(en.replace(/\s/g, ''))) return notify('يجب إدخال الاسم الرباعي باللغة الإنجليزية صحيحًا', 'error');
    setSavingName(true);
    const result = await updateStudentNames(renameStudent.id, ar, en);
    setSavingName(false);
    if (result.error) return notify(errorMessage(result.error, 'تعذر تعديل الاسم.'), 'error');
    if (result.data && !result.data.ok) return notify(result.data.error ?? 'تعذر تعديل الاسم.', 'error');
    setStudents(prev => prev.map((item) => item.id === renameStudent.id ? { ...item, full_name_ar: ar, full_name_en: en } : item));
    setRenameStudent(null);
    notify('تم تعديل اسم الطالب، والاسم الجديد ظهر في كل النظام والكشوفات.', 'success');
  }
  async function purgeStudent(student: Student) {
    const confirmText = `حذف ${student.full_name_ar} نهائيًا؟\nسيتم مسف الحساب وكلمة المرور والحضور والمواد ومفاتيح الأجهزة والرقم القومي من النظام بالكامل، ولا يمكن التراجع عن هذا الإجراء.`;
    if (!window.confirm(confirmText)) return;
    setPurgingId(student.id);
    try {
      const res = await insforge.functions.invoke('purge-student', { body: { student_id: student.id } });
      if (res.error) notify(errorMessage(res.error, 'تعذر حذف الطالب.'), 'error');
      else { notify('تم حذف الطالب نهائيًا من النظام بالكامل.', 'success'); void load(); }
    } catch (error) { notify(errorMessage(error, 'تعذر حذف الطالب.'), 'error'); }
    setPurgingId(null);
  }

  const [passwordTarget, setPasswordTarget] = useState<Student | null>(null);
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);
  async function openPasswordReset(student: Student) {
    if (!window.confirm(`تعيين كلمة مرور جديدة لـ ${student.full_name_ar}؟\nستظهر لك الكلمة مرة واحدة فقط لإملائها له، ثم لا يمكن استعادتها من النظام مرة أخرى.`)) return;
    setPasswordTarget(student);
    setPasswordBusy(true);
    setGeneratedPassword(null);
    setPasswordCopied(false);
    const result = await adminSetStudentPassword(student.id);
    setPasswordBusy(false);
    if (result.error || !result.data) return notify(errorMessage(result.error, 'تعذر تعيين كلمة المرور.'), 'error');
    setGeneratedPassword(result.data);
    void load();
  }
  async function copyPassword() {
    if (!generatedPassword) return;
    try { await navigator.clipboard.writeText(generatedPassword); setPasswordCopied(true); } catch { setPasswordCopied(false); }
  }

  const filtered = students.filter((item) => (filter === 'all' || item.status === filter) && (levelFilter === '' || item.level === levelFilter) && [item.full_name_ar, item.full_name_en, item.national_id, item.email].some((value) => value.toLowerCase().includes(search.toLowerCase())));

  return <main className="content-area"><div className="page-intro"><div><span className="eyebrow">إدارة المستخدمين</span><h2>طلبات تسجيل الطلاب</h2><p>{scope.is_super ? 'راجع طلبات تسجيل الطلاب وحالات الحسابات واعتمد المعلق منها.' : `طلاب موادك فقط (${scope.subject_names.join('، ') || 'لا مواد'}) — الفرقة ${lockedLevels.join('، ') || '—'}. لا تظهر لك أي مادة أو فرقة أخرى.`}</p></div></div><div className="filter-bar"><div className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="بحث بالاسم أو الرقم القومي…" /></div><div className="filter-tabs">{[['all', 'الكل'], ['pending', 'معلق'], ['approved', 'معتمد'], ['rejected', 'مرفوض']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value as typeof filter)}>{label}<span>{value === 'all' ? students.length : students.filter((student) => student.status === value).length}</span></button>)}</div><select className="filter-select" value={levelFilter} onChange={e => setLevelFilter(Number(e.target.value) || '')} disabled={lockedLevels.length === 1}>{scope.is_super && <option value="">جميع الفرق</option>}{adminLevelOptions(scope).map((level) => <option key={level} value={level}>الفرقة {level}</option>)}</select><button className="icon-button" onClick={() => void load()} title="تحديث"><RefreshCw size={17} /></button></div><div className="table-card">
        {loading ? <InlineLoading /> : <><div className="table-card-head"><div><span className="eyebrow">الحسابات</span><h3>طلبات تسجيل الطلاب</h3></div></div><div className="responsive-table"><table><thead><tr><th>الطالب</th><th>الرقم القومي</th><th>الفرقة والترم</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id}><td><div className="table-person"><div className="avatar small-avatar">{item.full_name_ar.slice(0, 1)}</div><span><b>{item.full_name_ar}</b><small dir="ltr">{item.email}</small></span></div></td><td dir="ltr">{item.national_id}</td><td>الفرقة {item.level} · {TERM_LABELS[item.term]}</td><td><span className={`status-pill ${item.status}`}>{STATUS_LABELS[item.status]}</span></td><td>{item.status === 'pending' ? <div className="row-actions"><button className="approve-button" onClick={() => void changeStatus(item, 'approved')}><Check size={15} /> اعتماد</button><button className="reject-button" onClick={() => void changeStatus(item, 'rejected')}><X size={15} /></button></div> : <span className="muted">—</span>}<button className="icon-button" onClick={() => void openPasswordReset(item)} title="تعيين كلمة مرور جديدة وإظهارها لك مرة واحدة لتمليها على الطالب"><LockKeyhole size={15} /></button><button className="icon-button" onClick={() => openRename(item)} title="تعديل الاسم فقط (عربي + إنجليزي)" style={{ marginLeft: 6 }}><Pencil size={15} /></button>{scope.is_super && <button className="danger-solid-button" disabled={purgingId === item.id} onClick={() => void purgeStudent(item)} title="حذف نهائي من النظام بالكامل (المشرف العام فقط)" style={{ padding: '6px 12px', fontSize: '12px' }}>{purgingId === item.id ? 'جارٍ الحذف…' : <><Trash2 size={14} /> حذف نهائي</>}</button>}</td></tr>)}</tbody></table>{!filtered.length && <EmptyState title="لا توجد نتائج" description="جرّب تغيير كلمات البحث أو الفلتر." />}</div></>}</div>

      {passwordTarget && (
        <div className="modal-overlay" onClick={() => { if (!passwordBusy) setPasswordTarget(null); }}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>كلمة المرور الجديدة — {passwordTarget.full_name_ar}</h3>
              <button className="icon-button" onClick={() => setPasswordTarget(null)} disabled={passwordBusy}><X size={18} /></button>
            </div>
            <div className="modal-body">
              {passwordBusy ? (
                <p className="modal-subtitle"><span className="button-spinner" /> جارٍ توليد وتعيين كلمة المرور…</p>
              ) : generatedPassword ? (
                <>
                  <p className="modal-subtitle">كلمة مرور قوية ومقروءة واضحة للإملاء بالصوت. تظهر <b>مرة واحدة فقط</b> — انسخها أو اكتبها الآن، ثم أبلغ الطالب بها واقترح عليه تغييرها من ملفه بعد الدخول.</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0' }}>
                    <code dir="ltr" style={{ fontSize: 20, letterSpacing: 1.5, background: 'var(--surface-2, #f4f4f6)', padding: '10px 16px', borderRadius: 10, fontWeight: 700, flex: 1, textAlign: 'center' }}>{generatedPassword}</code>
                    <button className="secondary-button" onClick={() => void copyPassword()}>{passwordCopied ? 'تم النسخ ✓' : 'نسخ'}</button>
                  </div>
                  <p className="modal-subtitle">كلمة مرور الطالب السابقة لم تعد صالحة. أي طلب إعادة تعيين معلق له أُلغي تلقائيًا.</p>
                </>
              ) : (
                <p className="modal-subtitle">تعذر توليد الكلمة. أغلق النافذة وأعد المحاولة.</p>
              )}
            </div>
            <div className="modal-footer">
              <button className="primary-button" onClick={() => setPasswordTarget(null)} disabled={passwordBusy}>تم، إغلاق</button>
            </div>
          </div>
        </div>
      )}

      {renameStudent && (
        <div className="modal-overlay" onClick={() => { if (!savingName) setRenameStudent(null); }}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>تعديل اسم الطالب</h3>
              <button className="icon-button" onClick={() => setRenameStudent(null)} disabled={savingName}><X size={18} /></button>
            </div>
            <div className="modal-body">
              <p className="modal-subtitle">تعديل الاسم بالعربية والإنجليزية فقط — لا يتغيّر أي حقل آخر (الرقم القومي والبريد والحساب كما هي)، والاسم الجديد يظهر في كل النظام والكشوفات.</p>
              <div className="stack-form">
                <label>الاسم بالعربية (رباعي)
                  <input value={renameAr} onChange={(e) => setRenameAr(e.target.value)} dir="rtl" disabled={savingName} />
                </label>
                <label>الاسم بالإنجليزية (رباعي)
                  <input value={renameEn} onChange={(e) => setRenameEn(e.target.value)} dir="ltr" disabled={savingName} />
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <button className="secondary-button" onClick={() => setRenameStudent(null)} disabled={savingName}>إلغاء</button>
              <button className="primary-button" onClick={() => void saveRename()} disabled={savingName}>
                {savingName ? <><span className="button-spinner" /> جارٍ الحفظ…</> : <>حفظ الاسم</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>;
}

function AdminWhitelist({ scope, notify }: { scope: AdminScope; notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [whitelist, setWhitelist] = useState<Array<{ national_id: string; full_name_reference: string | null; level: number | null; is_claimed: boolean }>>([]);
  const [levelFilter, setLevelFilter] = useState<number | ''>('');
  // أدمن المادة: مستواه/مستوياته فقط — مثبتة بلا أي اختيار آخر.
  const lockedLevels = scope.is_super ? [] : scope.levels;
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const uploadRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    setLoading(true);
    const whitelistResult = await getWhitelistEntries();
    if (whitelistResult.error) notify(errorMessage(whitelistResult.error), 'error');
    setWhitelist(whitelistResult.data);
    setLoading(false);
  }, [notify]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (lockedLevels.length === 1) setLevelFilter(lockedLevels[0]); }, [lockedLevels.join(',')]);
  async function importWhitelist(file: File | undefined) {
    if (!file) return;
    try {
      const parsed = await parseWhitelistFile(file);
      if (!parsed.records.length) throw new Error('لم نجد أرقام هوية صحيحة في الملف. المقبول: الرقم القومي المصري (14 رقمًا) أو الرقم المدني العماني (6–9 أرقام).');
      const result = await importNationalIds(parsed.records);
      if (result.error) throw new Error(errorMessage(result.error, 'تعذر رفع القائمة.'));
      const report = result.data;
      notify(`تمت إضافة ${report?.inserted_count ?? 0} وتحديث ${report?.updated_count ?? 0}. تم تجاهل ${parsed.rejectedRows + parsed.duplicateRows} صف غير صالح/مكرر و${report?.skipped_claimed_count ?? 0} رقم مستخدم.`, 'success');
      await load();
    } catch (error) { notify(errorMessage(error, 'تعذر قراءة الملف.'), 'error'); }
    if (uploadRef.current) uploadRef.current.value = '';
  }
  const [purging, setPurging] = useState<string | null>(null);
  async function purgeEntry(item: { national_id: string; full_name_reference: string | null; is_claimed: boolean }) {
    if (item.is_claimed) {
      const { data: stu, error: stuErr } = await database.from('students').select('id, full_name_ar').eq('national_id', item.national_id).maybeSingle();
      const student = stu as { id: string; full_name_ar: string } | null;
      if (stuErr || !student) return notify('لم يتم العثور على حساب الطالب المرتبط بهذا الرقم.', 'error');
      const confirmText = `حذف ${student.full_name_ar} نهائيًا من النظام بالكامل؟\nسيتم مسح الحساب وكلمة المرور والحضور والمواد ومفاتيح الأجهزة وتحرير الرقم القومي، ولا يمكن التراجع عن هذا الإجراء.`;
      if (!window.confirm(confirmText)) return;
      setPurging(item.national_id);
      try {
        const res = await insforge.functions.invoke('purge-student', { body: { student_id: student.id } });
        if (res.error) notify(errorMessage(res.error, 'تعذر حذف الطالب.'), 'error');
        else notify('تم حذف الطالب نهائيًا من النظام بالكامل وتحرير الرقم القومي.', 'success');
      } catch (error) { notify(errorMessage(error, 'تعذر حذف الطالب.'), 'error'); }
    } else {
      if (!window.confirm(`حذف الرقم ${item.national_id} (${item.full_name_reference || 'بدون اسم'}) نهائيًا من قائمة الأرقام المسموح بها؟`)) return;
      setPurging(item.national_id);
      const { error } = await database.from('national_ids').delete().eq('national_id', item.national_id);
      if (error) notify(errorMessage(error, 'تعذر حذف الرقم.'), 'error');
      else notify('تم حذف الرقم من القائمة نهائيًا.', 'success');
    }
    setPurging(null);
    void load();
  }
  const normalizeSearch = (value: string) => value.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[\u064B-\u065F]/g, '').trim();
  const searchQuery = normalizeSearch(search);
  const filteredWhitelist = whitelist.filter((item) => {
    if (levelFilter !== '' && item.level !== levelFilter) return false;
    if (!searchQuery) return true;
    return [item.national_id, item.full_name_reference ?? ''].some((value) => normalizeSearch(value).includes(searchQuery));
  });
  return (
    <main className="content-area">
      <div className="page-intro">
        <div>
          <span className="eyebrow">إدارة التسجيل</span>
          <h2>الأرقام المسموح لها بالتسجيل</h2>
          <p>{scope.is_super ? 'قائمة الأرقام القومية المعتمدة للتسجيل في الكلية. استورد ملفًا لإضافة أرقام جديدة.' : `أرقام الفرقة ${lockedLevels.join('، ') || '—'} فقط — اضطلاع فقط، والاستيراد والحذف للمشرف العام.`}</p>
        </div>
        {scope.is_super && (
          <>
            <input ref={uploadRef} type="file" accept=".csv,.xlsx" hidden onChange={(event) => void importWhitelist(event.target.files?.[0])} />
            <button className="secondary-button" onClick={() => uploadRef.current?.click()}><Download size={17} /> استيراد قائمة الأرقام</button>
          </>
        )}
      </div>
      <div className="filter-bar">
        <div className="search-box">
          <Search size={17} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="بحث بالاسم أو الرقم القومي…" />
        </div>
        <select className="filter-select" value={levelFilter} onChange={e => setLevelFilter(Number(e.target.value) || '')} disabled={lockedLevels.length === 1}>
          {scope.is_super && <option value="">جميع الفرق</option>}
          {adminLevelOptions(scope).map((level) => <option key={level} value={level}>الفرقة {level}</option>)}
        </select>
        <button className="icon-button" onClick={() => void load()} title="تحديث"><RefreshCw size={17} /></button>
      </div>
      <div className="table-card">
        <div className="table-card-head">
          <div><span className="eyebrow">Whitelist</span><h3>الأرقام المسموح لها بالتسجيل ({filteredWhitelist.length})</h3></div>
        </div>
        {loading ? <InlineLoading /> : (
          <div className="responsive-table">
            <table>
              <thead>
                <tr><th>الاسم المرجعي</th><th>الرقم القومي</th><th>الفرقة</th><th>الحالة</th><th>الإجراء</th></tr>
              </thead>
              <tbody>
                {filteredWhitelist.map((item) => (
                  <tr key={item.national_id}>
                    <td>{item.full_name_reference || '—'}</td>
                    <td dir="ltr">{item.national_id}</td>
                    <td>{item.level ? `الفرقة ${item.level}` : '—'}</td>
                    <td><span className={`status-pill ${item.is_claimed ? 'approved' : 'pending'}`}>{item.is_claimed ? 'مستخدم' : 'متاح'}</span></td>
                    <td>{scope.is_super ? <button className="danger-solid-button" disabled={purging === item.national_id} onClick={() => void purgeEntry(item)} title={item.is_claimed ? 'حذف الطالب نهائيًا من النظام بالكامل' : 'حذف الرقم نهائيًا من القائمة'} style={{ padding: '6px 12px', fontSize: '12px' }}>{purging === item.national_id ? 'جارٍ الحذف…' : <><Trash2 size={14} /> حذف نهائي</>}</button> : <span className="muted">للإطلاع فقط</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filteredWhitelist.length && <EmptyState title="لا توجد أرقام مرفوعة" description="استورد ملفًا يحتوي على الرقم القومي والاسم والمستوى." />}
          </div>
        )}
      </div>
    </main>
  );
}

function AdminSessions({ admin, scope, notify }: { admin: Admin; scope: AdminScope; notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [attendance, setAttendance] = useState<Array<Record<string, unknown>>>([]);
  const [viewedSessionId, setViewedSessionId] = useState('');
  const [retroOpen, setRetroOpen] = useState(false);
  const [retroSessionId, setRetroSessionId] = useState('');
  const [retroInput, setRetroInput] = useState('');
  const [retroBusy, setRetroBusy] = useState(false);
  const [retroResults, setRetroResults] = useState<Array<{ nid: string; ok: boolean; message: string; name?: string }>>([]);
  const [removingId, setRemovingId] = useState('');
  async function removeAttendanceLog(row: Record<string, unknown>) {
    const person = row.students as { full_name_ar?: string } | undefined;
    const name = person?.full_name_ar ?? 'هذا الطالب';
    if (!window.confirm(`حذف حضور ${name} من هذه الجلسة فعليًا؟\nسيُحتسب بعدها غيابًا في كل الكشوفات وربما تُطبَّق عليه المادة ٣٥ عند التنفيذ.`)) return;
    setRemovingId(String(row.id));
    const res = await adminRemoveAttendance(String(row.id));
    setRemovingId('');
    if (res.error) return notify(errorMessage(res.error, 'تعذر حذف سجل الحضور.'), 'error');
    notify(`تم حذف حضور ${name} فعليًا — سيُحتسب غيابًا في كل الكشوفات.`, 'success');
    if (viewedSessionId) void viewAttendance(viewedSessionId);
    if (absentSessionId === viewedSessionId) void computeAbsentees(viewedSessionId);
  }
  const load = useCallback(async () => { setLoading(true); const [sessionResult, subjectResult] = await Promise.all([getAdminSessions(), database.from('subjects').select('*').order('level').order('name_ar')]); setSessions(sessionResult.data); const allSubjects = (subjectResult.data as Subject[]) ?? []; setSubjects(scope.is_super ? allSubjects : allSubjects.filter((subject) => scope.subject_ids.includes(subject.id))); setLoading(false); }, [scope]);
  useEffect(() => { void load(); }, [load]);
  async function startSession() { if (!selected) return notify('اختر المادة أولًا.', 'error'); const result = await openLecture(selected, admin.id); if (result.error) return notify(errorMessage(result.error), 'error'); notify('تم بدء المحاضرة ويمكن للطلاب تسجيل الحضور الآن.', 'success'); setSelected(''); void load(); }
  async function endSession(sessionId: string) { const result = await database.from('lecture_sessions').update({ is_active: false, closed_at: new Date().toISOString() }).eq('id', sessionId); if (result.error) return notify(errorMessage(result.error), 'error'); notify('تم إنهاء المحاضرة وإغلاق التسجيل.', 'success'); void load(); }
  async function viewAttendance(sessionId: string) { const result = await getSessionAttendance(sessionId); if (result.error) notify(errorMessage(result.error), 'error'); setViewedSessionId(sessionId); setAttendance((result.data as Array<Record<string, unknown>>) ?? []); }
  async function viewAttendanceAndAbsentees(sessionId: string) { await viewAttendance(sessionId); void computeAbsentees(sessionId); }
  function openRetro(sessionId: string) { setRetroSessionId(sessionId); setRetroInput(''); setRetroResults([]); setRetroOpen(true); }
  async function submitRetroAttendance() {
    if (!retroSessionId) return notify('اختر الجلسة أولًا.', 'error');
    const ids = [...new Set(retroInput.split(/[\n,،\s]+/).map((raw) => raw.replace(/\D/g, '')).filter(Boolean))];
    if (!ids.length) return notify('أدخل رقمًا قوميًا واحدًا على الأقل.', 'error');
    if (ids.length > 200) return notify('الحد الأقصى 200 رقم في الدفعة الواحدة.', 'error');
    setRetroBusy(true);
    const results: Array<{ nid: string; ok: boolean; message: string; name?: string }> = [];
    for (const nid of ids) {
      const res = await adminAddRetroAttendance(retroSessionId, nid);
      const payload = res.data;
      if (res.error) results.push({ nid, ok: false, message: errorMessage(res.error, 'تعذر إضافة الطالب.') });
      else if (payload?.ok) results.push({ nid, ok: true, message: payload.already_present ? 'كان مسجلًا في هذه الجلسة بالفعل.' : (payload.message ?? 'تم تسجيل حضوره بوقت الجلسة.'), name: payload.student_name });
      else results.push({ nid, ok: false, message: payload?.error ?? 'تعذر إضافة الطالب.' });
    }
    setRetroResults(results);
    setRetroBusy(false);
    const okCount = results.filter((result) => result.ok).length;
    notify(`تم اعتماد ${okCount} من ${ids.length} رقم.`, okCount === ids.length ? 'success' : 'info');
    void load();
    if (viewedSessionId === retroSessionId) void viewAttendance(retroSessionId);
  }
  useEffect(() => { let disposed = false; insforge.realtime.connect().then(() => insforge.realtime.subscribe('attendance-live')).catch(() => undefined); const refresh = window.setInterval(() => { if (!disposed) void load(); }, 10000); return () => { disposed = true; window.clearInterval(refresh); insforge.realtime.unsubscribe('attendance-live'); }; }, [load]);
  const active = sessions.filter((session) => session.is_active);

  // ─── الإنذار الفوري بعد إقفال المحاضرة ───
  // عند اختيار جلسة مغلقة لعرض حضورها، تظهر هنا قائمة الغائبين من مسجّلي المادة
  // مع زر تنفيذ فوري للمادة ٣٥ (إنذار أول/ثانٍ أو خصم+حرمان حسب تبعتهم السابقة).
  const [absentees, setAbsentees] = useState<AttendanceComplianceRow[]>([]);
  const [absenteesLoading, setAbsenteesLoading] = useState(false);
  const [absentSessionId, setAbsentSessionId] = useState('');
  const absentSession = sessions.find((s) => s.id === absentSessionId);
  async function computeAbsentees(sessionId: string) {
    setAbsentSessionId(sessionId);
    setAbsentees([]);
    setAbsenteesLoading(true);
    const session = sessions.find((s) => s.id === sessionId);
    const [compliance, attendanceResult] = await Promise.all([
      getAttendanceCompliance(undefined, session?.subject_id),
      getSessionAttendance(sessionId),
    ]);
    const attendedIds = new Set(((attendanceResult.data as Array<Record<string, unknown>>) ?? []).map((row) => String(row.student_id)));
    setAbsentees((compliance.data ?? []).filter((row) => !attendedIds.has(row.student_id)));
    setAbsenteesLoading(false);
  }
  const nextDue = (row: AttendanceComplianceRow) => row.warning_count + row.deduction_count + 1;
  const dueTotal = absentees.filter((row) => nextDue(row) <= 2).length; // الإنذار الأول/الثاني فقط — الخصم بعد الثانية يُنفّذ من تاب ٣٥ لحماية الدرجات
  const [lawBusyKey, setLawBusyKey] = useState<string | null>(null);
  async function executeLawQuick(row: AttendanceComplianceRow) {
    const ordinal = nextDue(row);
    const summary = `الحضور ${row.attendance_percent}% (${row.attended_sessions} من ${row.total_sessions}).\n\nالإجراء الحالي: ${ordinal <= 2 ? `إنذار ${ordinal === 1 ? 'أول' : 'ثانٍ'} للطالب` : 'خصم درجة كاملة من أعمال السنة (سريًا) + إعلان الحرمان للطالب'}.\n\nهل تريد تنفيذ القانون الآن؟`;
    if (!window.confirm(summary)) return;
    const key = `quick-${row.student_id}-${row.subject_id}`;
    setLawBusyKey(key);
    const result = await executeAttendanceLaw(row.student_id, row.subject_id);
    setLawBusyKey(null);
    if (result.error) return notify(errorMessage(result.error, 'تعذر تنفيذ القانون.'), 'error');
    const action = result.data?.[0];
    if (action?.action_type === 'warning') notify(`تم إصدار إنذار ${action.action_number === 1 ? 'أول' : 'ثانٍ'} للطالب — سيظهر له التنبيه عند دخوله.`, 'success');
    else notify('تم خصم درجة كاملة من الدرجات السرية، وأصبح الطالب محرومًا — يظهر له تنبيه الحرمان مع نص المادة ٣٥.', 'success');
    void computeAbsentees(absentSessionId);
  }
  return <main className="content-area"><div className="page-intro"><div><span className="eyebrow">تشغيل المحاضرات</span><h2>الجلسات والحضور</h2><p>{scope.is_super ? 'ابدأ محاضرة، راقب التسجيل لحظيًا، ثم أغلق الجلسة عند الانتهاء.' : `جلسات موادك فقط (${scope.subject_names.join('، ') || 'لا مواد'}) — الفرقة ${scope.levels.join('، ') || '—'}، ولا تظهر لك جلسات أي مادة أخرى.`}</p></div><span className="realtime-chip"><span /> تحديث لحظي</span></div><section className="open-session-panel"><div><span className="eyebrow">جلسة جديدة</span><h3>بدء محاضرة</h3><p>اختر المادة ثم افتح التسجيل للطلاب المعتمدين.</p></div><div className="session-launch"><select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">اختر المادة…</option>{subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name_ar} · الفرقة {subject.level}</option>)}</select><button className="primary-button" onClick={() => void startSession()}><Activity size={17} /> بدء المحاضرة</button>{!scope.is_super && <small style={{ color: 'var(--muted)', fontSize: 12 }}>القائمة محصورة في موادك المسندة فقط.</small>}</div></section><div className="section-heading standalone"><div><span className="eyebrow">المحاضرات</span><h3>الجلسات المفتوحة والمغلقة</h3></div><button className="icon-button" onClick={() => void load()}><RefreshCw size={17} /></button></div><div className="session-admin-grid">{loading ? <InlineLoading /> : sessions.map((session) => <div className={`admin-session-card ${session.is_active ? 'active' : 'closed'}`} key={session.id}><div className="session-top"><span className={session.is_active ? 'live-dot' : 'closed-dot'}>{session.is_active ? <><span /> مباشر</> : 'مغلقة'}</span><span>{new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(new Date(session.opened_at))}</span></div><h4>{session.subject?.name_ar}</h4><div className="session-meta"><span><Clock3 size={14} /> {new Intl.DateTimeFormat('ar-EG', { timeStyle: 'short' }).format(new Date(session.opened_at))}</span><span><Users size={14} /> التسجيلات تظهر هنا</span></div><div className="session-actions"><button className="secondary-button" onClick={() => void viewAttendanceAndAbsentees(session.id)}>عرض الحضور</button>{session.is_active && <button className="danger-button" onClick={() => void endSession(session.id)}>إنهاء</button>}{!session.is_active && <button className="secondary-button" onClick={() => openRetro(session.id)} title="إضافة طالب بلغك بعد قفل الجلسة"><UserPlus size={15} /> إضافة حضور لاحق</button>} {scope.is_super && <button className="danger-solid-button" style={{ opacity: 0.95 }} onClick={async () => { if (typeof window !== 'undefined' && window.confirm('هل أنت متأكد من حذف الجلسة نهائياً؟ سيتم حذف جميع سجلات الحضور المرتبطة بها.')) { const res = await insforge.functions.invoke('delete-session-permanently', { body: { session_id: session.id } }); if (res.error) notify(res.error.message || 'حدث خطأ', 'error'); else { notify('تم حذف الجلسة بنجاح', 'success'); load(); } } }}>حذف نهائي</button>}</div></div>)}</div>{sessions.filter((session) => session.is_active).map((session) => <AdminAudioBeacon key={`beacon-${session.id}`} sessionId={session.id} subjectId={session.subject_id} active={session.is_active} beaconActive={!!session.is_attendance_active} frequency={session.audio_token_frequency} notify={notify} onChanged={() => void load()} />)}{attendance.length > 0 && <div className="table-card attendance-live-table"><div className="table-card-head"><h3>حضور الجلسة المحددة</h3><span>{attendance.length} طالب</span></div><div className="responsive-table"><table><thead><tr><th>الطالب</th><th>الرقم القومي</th><th>وقت التسجيل</th><th>المسافة</th><th>إجراء</th></tr></thead><tbody>{attendance.map((row) => { const person = row.students as { full_name_ar?: string; national_id?: string } | undefined; return <tr key={String(row.id)}><td>{person?.full_name_ar ?? 'طالب'}</td><td dir="ltr">{person?.national_id ?? '—'}</td><td>{new Intl.DateTimeFormat('ar-EG', { timeStyle: 'medium' }).format(new Date(String(row.checked_in_at)))} </td><td>{Math.round(Number(row.distance_meters) || 0)} م</td><td><button className="reject-button" disabled={removingId === String(row.id)} title="حذف الحضور فعليًا — سيُحتسب غيابًا" onClick={() => void removeAttendanceLog(row)}>{removingId === String(row.id) ? 'جارٍ الحذف…' : <><Trash2 size={14} /> حذف</>}</button></td></tr>; })}</tbody></table></div></div>}
        {!absentSession?.is_active && absentSessionId && (
          <div className="table-card" style={{ marginTop: 16 }}>
            <div className="table-card-head">
              <div>
                <span className="eyebrow">متابعة المادة ٣٥</span>
                <h3>غائبو {absentSession?.subject?.name_ar} — {dueTotal ? `${dueTotal} مؤهل للإنذار الآن` : 'لا أحد متجاوز للإنذار الثاني بعد'}</h3>
              </div>
              <span>الحد الأدنى: 75%</span>
            </div>
            {absenteesLoading ? <InlineLoading /> : absentees.length === 0 ? (
              <EmptyState title="لا غائبين" description="كل الطلاب المسجلين في هذه المادة حضروا هذه الجلسة." />
            ) : (
              <div className="responsive-table">
                <table>
                  <thead>
                    <tr><th>الطالب</th><th>الرقم القومي</th><th>النسبة الكلية للمادة</th><th>ما فعلوه حتى الآن</th><th>الإجراء المقترح</th></tr>
                  </thead>
                  <tbody>
                    {absentees.map((row) => {
                      const ordinal = nextDue(row);
                      const outcome = ordinal <= 2 ? `إنذار ${ordinal === 1 ? 'أول' : 'ثانٍ'}` : 'خصم درجة + حرمان';
                      const key = `${row.student_id}-${row.subject_id}`;
                      return (
                        <tr key={key} style={row.deduction_count > 0 ? { background: '#fef2f2' } : undefined}>
                          <td><b>{row.student_name}</b></td>
                          <td dir="ltr">{row.national_id}</td>
                          <td><b style={{ color: row.below_minimum ? '#b91c1c' : undefined }}>{row.attendance_percent}%</b></td>
                          <td>{row.deduction_count > 0 ? <span className="status-pill rejected">محروم</span> : row.warning_count > 0 ? <span className="status-pill pending">{row.warning_count === 1 ? 'إنذار أول سابق' : 'إنذاران سابقان'}</span> : <span className="muted">لا إجراءات سابقة</span>}</td>
                          <td>
                            <button className={ordinal <= 2 ? 'approve-button' : 'danger-solid-button'} disabled={lawBusyKey === key || row.total_sessions === 0} onClick={() => void executeLawQuick(row)}>
                              <Check size={15} /> {ordinal <= 2 ? `إصدار ${outcome}` : outcome}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="notice-box" style={{ margin: 16 }}>
              <AlertTriangle size={19} />
              <div>
                <b>الآلية التلقائية</b>
                <p>هذه القائمة محسوبة تلقائيًا من كل الجلسات المغلقة للمادة وكل الإجراءات الصادرة سابًا. زر الإنذار الأول والثانٍ يسجّل الإجراء في ثانية واحدة ويظهر للطالب فور دخوله. بعد الإنذارين: الإجراء الثالث = خصم درجة كاملة + حرمان، ويُنفَّذ من نفس الزر أو من تاب «قانون الحضور ٣٥» لحماية الدرجات السرية من الضغط الخاطئ.</p>
              </div>
            </div>
          </div>
        )}{retroOpen && (
        <div className="modal-overlay" onClick={() => { if (!retroBusy) setRetroOpen(false); }}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ width: 'min(100%, 640px)' }}>
            <div className="modal-header">
              <h3>إضافة حضور طالب لجلسة منتهية</h3>
              <button className="icon-button" onClick={() => setRetroOpen(false)} disabled={retroBusy}><X size={18} /></button>
            </div>
            <div className="modal-body">
              <p className="modal-subtitle">اختر الجلسة (حتى لو مغلقة منذ أسابيع) وأدخل أرقام الطلبة القومية. سيُسجَّل الحضور بوقت الجلسة نفسها، وتُحسب درجة تلك الجلسة للطالب فورًا وتظهر في لوحة تحكمه أنه حضر.</p>
              <div className="stack-form">
                <label>الجلسة
                  <select value={retroSessionId} onChange={(e) => setRetroSessionId(e.target.value)} disabled={retroBusy}>
                    <option value="">اختر الجلسة…</option>
                    {sessions.map((s) => <option key={s.id} value={s.id}>{s.subject?.name_ar ?? 'جلسة'} — {new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s.opened_at))} {s.is_active ? '(نشطة)' : '(مغلقة)'}</option>)}
                  </select>
                </label>
                <label>أرقام الطلبة (قومي مصري 14 رقمًا أو مدني عماني 6–9) — رقم في كل سطر
                  <textarea value={retroInput} onChange={(e) => setRetroInput(e.target.value)} rows={6} dir="ltr" disabled={retroBusy} style={{ width: '100%', minHeight: 110 }} placeholder={'30507221301449\n20562903'} />
                </label>
              </div>
              {retroResults.length > 0 && (
                <div className="responsive-table" style={{ marginTop: '12px', maxHeight: 260, overflowY: 'auto' }}>
                  <table>
                    <thead><tr><th>الرقم</th><th>الطالب</th><th>النتيجة</th></tr></thead>
                    <tbody>
                      {retroResults.map((r) => <tr key={r.nid}><td dir="ltr">{r.nid}</td><td>{r.name ?? '—'}</td><td style={{ color: r.ok ? '#14806b' : '#b91c1c' }}>{r.ok ? '✓ ' : '✗ '}{r.message}</td></tr>)}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="secondary-button" onClick={() => setRetroOpen(false)} disabled={retroBusy}>إغلاق</button>
              <button className="primary-button" onClick={() => void submitRetroAttendance()} disabled={retroBusy || !retroSessionId}>
                {retroBusy ? <><span className="button-spinner" /> جارٍ الإضافة…</> : <>تسجيل الحضور</>}
              </button>
            </div>
          </div>
        </div>
      )}</main>;
}

function AdminGrades({ scope, notify }: { scope: AdminScope; notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const lockedLevels = scope.is_super ? [] : scope.levels;
  const [level, setLevel] = useState<number | ''>(() => (scope.is_super ? '' : (scope.levels[0] ?? '')));
  const [subjectId, setSubjectId] = useState<string>('');
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [grades, setGrades] = useState<SecretGrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [semester, setSemester] = useState<string>('');
  const [academicYear, setAcademicYear] = useState<string>('2025 / 2026');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editGrade, setEditGrade] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newStudent, setNewStudent] = useState({ name: '', nationalId: '', grade: '' });
  const [adding, setAdding] = useState(false);

  const sortArabicStudents = <T extends { student_name: string }>(list: T[]): T[] =>
    [...list].sort((a, b) => (a.student_name || '').localeCompare(b.student_name || '', 'ar'));

  // 2025/2026 onward, indefinitely — the program keeps working every future year.
  const academicYearOptions = (() => {
    const start = 2025;
    const startYear = Number(String(new Date().getFullYear()));
    const end = Math.max(startYear, start + 5);
    const options: string[] = [];
    for (let year = start; year <= end; year += 1) options.push(`${year} / ${year + 1}`);
    return options;
  })();

  useEffect(() => {
    if (level) {
      insforge.database.from('subjects').select('*').eq('level', level).then((res) => {
        const all = ((res.data as Subject[]) || []);
        const visible = scope.is_super ? all : all.filter((subject) => scope.subject_ids.includes(subject.id));
        setSubjects(visible);
        // أدمن مادة له مادة واحدة في الفرقة → تُختار تلقائيًا بلا أي فرصة للخروج عن نطاقه.
        setSubjectId(visible.length === 1 ? visible[0].id : '');
      });
    } else {
      setSubjects([]);
      setSubjectId('');
    }
  }, [level, scope]);

  const load = useCallback(async () => {
    if (!subjectId) return setGrades([]);
    setLoading(true);
    const res = await getSecretGrades(subjectId);
    setGrades(sortArabicStudents(res.data ?? []));
    setLoading(false);
  }, [subjectId]);

  useEffect(() => { void load(); }, [load]);

  const [exportingGoogle, setExportingGoogle] = useState(false);

  function exportGrades() {
    if (!grades.length) return notify('لا توجد درجات لتصديرها حالياً.', 'info');
    setExporting(true);
    try {
      const subject = subjects.find(s => s.id === subjectId);
      const header = '#,"اسم الطالب","الرقم القومي","المادة","المحاضرات الحاضرة","إجمالي المحاضرات","الدرجة القصوى","أعمال السنة"';
      const rows = grades.map((g, i) =>
        [i + 1, `"${(g.student_name || '').replace(/"/g, '""')}"`, `"${g.national_id || ''}"`, `"${(g.subject_name || '').replace(/"/g, '""')}"`, g.attended_sessions, g.total_sessions, g.max_grade, g.grade ?? ''].join(',')
      );
      const csv = ['\uFEFF' + header, ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `سجل_الدرجات_السري_${(subject?.name_ar || subjectId).replace(/\s+/g, '_')}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify('تم تصدير الدرجات إلى Excel بنجاح.', 'success');
    } finally {
      setExporting(false);
    }
  }

  async function exportToGoogleSheets() {
    if (!subjectId) return notify('يرجى اختيار المادة أولاً.', 'info');
    if (!grades.length) return notify('لا توجد درجات مسجلة لتصديرها حالياً.', 'info');
    setExportingGoogle(true);
    try {
      const subject = subjects.find(s => s.id === subjectId);
      const res = await insforge.functions.invoke('google-export', {
        body: { subject_id: subjectId, subject_name: subject?.name_ar, grades }
      });
      if (res.data?.url) {
        window.open(res.data.url, '_blank');
        notify('تم إنشاء وتصدير Google Sheet بنجاح!', 'success');
      } else if (res.data?.error === 'GOOGLE_OAUTH_REQUIRED' || (res.error as any)?.message?.includes('GOOGLE_OAUTH_REQUIRED')) {
        notify('جاري تحويلك لربط حساب Google للتصدير المباشر...', 'info');
        const startRes = await insforge.functions.invoke('google-auth-start', { body: {} });
        if (startRes.data?.url) {
          window.location.href = startRes.data.url;
        } else {
          notify(errorMessage(startRes.error, 'تعذر بدء ربط Google'), 'error');
        }
      } else {
        notify(errorMessage(res.error || res.data?.error, 'تعذر التصدير إلى Google Sheets'), 'error');
      }
    } catch (err) {
      notify(errorMessage(err, 'حدث خطأ أثناء التصدير إلى Google Sheets'), 'error');
    } finally {
      setExportingGoogle(false);
    }
  }

  function printSheet() {
    if (typeof window !== 'undefined') window.print();
  }

  function startEdit(grade: SecretGrade) {
    setEditingId(grade.student_id);
    setEditName(grade.student_name);
    setEditGrade(grade.grade != null ? String(grade.grade) : '');
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName('');
    setEditGrade('');
  }

  async function saveEdit(grade: SecretGrade) {
    const name = editName.trim();
    if (!name) return notify('اسم الطالب لا يمكن أن يكون فارغًا.', 'error');
    const parsedGrade = Number(editGrade);
    if (editGrade !== '' && (!Number.isFinite(parsedGrade) || parsedGrade < 0)) return notify('درجة أعمال السنة يجب أن تكون رقمًا صحيحًا موجبًا.', 'error');
    const finalGrade = editGrade === '' ? (null as unknown as number) : Math.ceil(parsedGrade);
    setSavingEdit(true);
    const res = await updateStudentGrade(grade.student_id, grade.subject_id, name, finalGrade);
    setSavingEdit(false);
    if (res.error) return notify(errorMessage(res.error), 'error');
    setGrades(prev => sortArabicStudents(prev.map(x => (x.student_id === grade.student_id && x.subject_id === grade.subject_id ? { ...x, student_name: name, grade: finalGrade } : x))));
    cancelEdit();
    notify('تم تحديث بيانات الطالب بنجاح.', 'success');
  }

  async function submitAddStudent() {
    const name = newStudent.name.trim();
    const nid = newStudent.nationalId.trim();
    const gradeRaw = newStudent.grade.trim();

    if (!/^[\u0600-\u065F\u066A-\u06D2\s]+$/.test(name.replace(/\s/g, ''))) return notify('يجب أن يحتوي الاسم على حروف عربية ومسافات فقط.', 'error');
    if (name.split(/\s+/).filter(Boolean).length < 4) return notify('يجب إدخال الاسم الرباعي بالكامل (4 كلمات على الأقل).', 'error');
    if (!/^(\d{6,9}|\d{14})$/.test(nid)) return notify('الرقم القومي يجب أن يتكون من 8 أو 9 أو 14 رقمًا بالضبط.', 'error');
    const parsedNewGrade = Number(gradeRaw);
    if (gradeRaw !== '' && !Number.isFinite(parsedNewGrade)) return notify('درجة أعمال السنة يجب أن تكون رقمًا صالحًا.', 'error');
    const newGrade = gradeRaw === '' ? undefined : Math.ceil(parsedNewGrade);

    setAdding(true);
    const res = await quickAddStudent(nid, name, subjectId, newGrade);
    setAdding(false);
    if (res.error || !res.data) return notify(errorMessage(res.error ?? new Error('فشل إضافة الطالب.')), 'error');
    const added = res.data;
    setGrades(prev => sortArabicStudents([...prev.filter(x => !(x.student_id === added.student_id && x.subject_id === added.subject_id)), added]));
    setNewStudent({ name: '', nationalId: '', grade: '' });
    setAddOpen(false);
    notify('تمت إضافة الطالب للمادة بنجاح.', 'success');
  }

  const subjectName = subjects.find(s => s.id === subjectId)?.name_ar ?? '';

  return (
    <main className="content-area">
      <div className="page-intro">
        <div>
          <span className="eyebrow">{scope.is_super ? 'للمدير فقط' : 'نطاقك المحدد'}</span>
          <h2>سجل الدرجات السري</h2>
          <p>{scope.is_super ? 'تُحسب أعمال السنة من نسبة الحضور مع إمكانية التعديل اليدوي.' : `درجات موادك فقط: ${scope.subject_names.join('، ') || 'لا مواد'} — الفرقة ${lockedLevels.join('، ') || '—'}.`}</p>
        </div>
        <div className="page-actions">
          <select className="filter-select" value={level} onChange={e => setLevel(Number(e.target.value) || '')} disabled={lockedLevels.length === 1}>
            {scope.is_super && <option value="">اختر الفرقة...</option>}
            {adminLevelOptions(scope).map((item) => <option key={item} value={item}>الفرقة {item}</option>)}
          </select>
          <select className="filter-select" value={subjectId} onChange={e => setSubjectId(e.target.value)} disabled={!level}>
            <option value="">اختر المادة...</option>
            {subjects.map(s => <option key={s.id} value={s.id}>{s.name_ar}</option>)}
          </select>
          <select className="filter-select" value={semester} onChange={e => setSemester(e.target.value)} disabled={!subjectId}>
            <option value="">اختر الفصل الدراسي...</option>
            <option value="term1">الفصل الدراسي الأول</option>
            <option value="term2">الفصل الدراسي الثاني</option>
            <option value="summer">الفصل الصيفي</option>
          </select>
          <select className="filter-select" value={academicYear} onChange={e => setAcademicYear(e.target.value)} disabled={!subjectId}>
            {academicYearOptions.map(year => <option key={year} value={year}>{year}</option>)}
          </select>
          <button className="secondary-button" onClick={() => void exportToGoogleSheets()} disabled={!subjectId || exportingGoogle || !grades.length} title="تصدير الشيت أونلاين إلى حساب Google Sheets">
            {exportingGoogle ? <><span className="button-spinner" /> جارٍ إنشاء الشيت...</> : <><FileSpreadsheet size={17} /> تصدير إلى Google Sheets</>}
          </button>
          <button className="secondary-button" onClick={() => void exportGrades()} disabled={!subjectId || exporting || !grades.length} title="تحميل ملف Excel">
            {exporting ? <><span className="button-spinner" /> جارٍ التصدير...</> : <><Download size={17} /> تصدير إلى Excel</>}
          </button>
          <button className="secondary-button" onClick={() => printSheet()} disabled={!subjectId || !grades.length}>
            <Printer size={17} /> طباعة كشف درجات أعمال السنة / التطبيقي
          </button>
          <button className="secondary-button" onClick={() => setAddOpen(true)} disabled={!subjectId}>
            <UserPlus size={17} /> إضافة طالب يدويًا
          </button>
          <button className="icon-button" onClick={() => void load()} disabled={!subjectId} title="تحديث"><RefreshCw size={17} /></button>
        </div>
      </div>

      <div className="secret-grade-banner">
        <div className="security-symbol"><LockKeyhole size={22} /></div>
        <div>
          <b>هذه البيانات محمية بصلاحية الإدمن</b>
          <p>الطلاب لا يستطيعون الوصول إلى هذا السجل عبر الواجهة أو سياسات قاعدة البيانات.</p>
        </div>
      </div>

      <div className="table-card">
        {loading ? <InlineLoading /> : (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>اسم الطالب</th>
                  <th>الرقم القومي</th>
                  <th>المادة</th>
                  <th>الحضور</th>
                  <th>الدرجة القصوى</th>
                  <th>أعمال السنة</th>
                  <th>الإجراءات</th>
                </tr>
              </thead>
              <tbody>
                {grades.map((grade, index) => {
                  const isEditing = editingId === grade.student_id;
                  return (
                    <tr key={`${grade.student_id}-${grade.subject_id}`}>
                      <td>{index + 1}</td>
                      {isEditing ? (
                        <td><input className="edit-input" value={editName} onChange={e => setEditName(e.target.value)} placeholder="اسم الطالب" dir="rtl" /></td>
                      ) : (
                        <td dir="rtl"><b>{grade.student_name}</b></td>
                      )}
                      <td dir="ltr">{grade.national_id}</td>
                      <td>{grade.subject_name}</td>
                      <td>{grade.attended_sessions} / {grade.total_sessions}</td>
                      <td>{grade.max_grade}</td>
                      {isEditing ? (
                        <td><input className="edit-input" type="number" min={0} value={editGrade} onChange={e => setEditGrade(e.target.value)} placeholder="الدرجة" dir="ltr" style={{ maxWidth: 90 }} /></td>
                      ) : (
                        <td><span className="grade-value">{grade.grade}</span></td>
                      )}
                      <td>
                        {isEditing ? (
                          <div className="row-actions">
                            <button className="icon-button" onClick={() => void saveEdit(grade)} disabled={savingEdit} title="حفظ">
                              {savingEdit ? <span className="button-spinner" /> : <Check size={16} />}
                            </button>
                            <button className="icon-button" onClick={() => cancelEdit()} disabled={savingEdit} title="إلغاء">
                              <X size={16} />
                            </button>
                          </div>
                        ) : (
                          <button className="icon-button" onClick={() => startEdit(grade)} title="تعديل">
                            <Pencil size={15} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!grades.length && <EmptyState title="لا توجد درجات محسوبة بعد" description="تظهر درجات الطلاب تلقائيًا بعد فتح المحاضرات وتسجيل الحضور، أو يمكنك إضافة طالب يدويًا." />}
          </div>
        )}
      </div>

      {addOpen && (
        <div className="modal-overlay" onClick={() => { if (!adding) setAddOpen(false); }}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>إضافة طالب يدويًا (تسجيل متأخر)</h3>
              <button className="icon-button" onClick={() => setAddOpen(false)} disabled={adding}><X size={18} /></button>
            </div>
            <div className="modal-body">
              <p className="modal-subtitle">سجّل طالبًا متأخرًا مباشرةً في المادة المحددة وحدد درجة أعمال السنة.</p>
              <div className="stack-form">
                <label>الاسم بالكامل باللغة العربية
                  <input value={newStudent.name} onChange={e => setNewStudent({ ...newStudent, name: e.target.value })} placeholder="مثال: محمد أحمد علي إبراهيم" dir="rtl" disabled={adding} />
                </label>
                <label>الرقم القومي
                  <input value={newStudent.nationalId} onChange={e => setNewStudent({ ...newStudent, nationalId: e.target.value })} placeholder="14 رقمًا (قومي مصري) أو 6–9 أرقام (مدني عماني)" dir="ltr" disabled={adding} />
                </label>
                <label>درجة أعمال السنة (اختياري)
                  <input type="number" min={0} value={newStudent.grade} onChange={e => setNewStudent({ ...newStudent, grade: e.target.value })} placeholder="اتركه فارغًا ليُحسب تلقائيًا من الحضور" dir="ltr" disabled={adding} />
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <button className="secondary-button" onClick={() => setAddOpen(false)} disabled={adding}>إلغاء</button>
              <button className="primary-button" onClick={() => void submitAddStudent()} disabled={adding}>
                {adding ? <><span className="button-spinner" /> جارٍ الإضافة...</> : <>إضافة الطالب</>}
              </button>
            </div>
          </div>
        </div>
      )}

      <PrintableAttendanceSheet
        students={grades}
        level={level}
        semester={semester}
        academicYear={academicYear}
        subjectName={subjectName}
      />
    </main>
  );
}

// ─── لوحة الأدمن: قانون المادة ٣٥ (حضور ومواظبة الطلاب وحرمانهم) ───
export const LAW_TEXT = 'المادة (٣٥) حضور ومواظبة الطلاب وحرمانهم أو إلغاء قيدهم: على الطالب الانتظام والمواظبة في حضور المحاضرات والدروس التطبيقية/العملية، ويُحرم من دخول الامتحان النهائي إذا قلّت نسبة حضوره عن 75% من المحاضرات المحددة للمقرر، ويُعد الطالب المحروم راسبًا في المقرر ويرصد له تقدير (حرمان).';

function AdminAttendanceLaw({ scope, notify }: { scope: AdminScope; notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  // نطاق أدمن المادة: مواده ومستوياته فقط — مثبت في الفلاتر وفي قاعدة البيانات معًا.
  const lockedLevels = scope.is_super ? [] : scope.levels;
  const [rows, setRows] = useState<AttendanceComplianceRow[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [levelFilter, setLevelFilter] = useState<number | ''>(() => (scope.is_super ? '' : (scope.levels[0] ?? '')));
  const [subjectFilter, setSubjectFilter] = useState<string>('');
  const [onlyViolators, setOnlyViolators] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showLaw, setShowLaw] = useState(false);
  const [due, setDue] = useState<LawDueSummary | null>(null);
  const [scanBusy, setScanBusy] = useState(false);

  // تنفيذ كل المستحق الآن بضغطة واحدة: إنذار أول/ثانٍ لمن عليه الحق، ثم الحرمان.
  // نفس المحرك الذي يعمل تلقائيًا من الجدول المجدول — لا خصم درجات تلقائي.
  async function runDueScan(dryRun: boolean) {
    setScanBusy(true);
    const { data, error } = await runLaw35Scan({ dryRun });
    setScanBusy(false);
    if (error) return notify(errorMessage(error, 'تعذر تنفيذ الفحص.'), 'error');
    const warnings = data.filter((row) => row.action_type === 'warning').length;
    const bans = data.filter((row) => row.action_type === 'deprivation').length;
    if (dryRun) notify(`فحص تجريبي: ${warnings} إنذار و ${bans} حرمان مستحق الآن (لم يُنفَّذ شيء).`, 'info');
    else if (!data.length) notify('لا يوجد إجراء مستحق الآن — كل الإنذارات الحالية صدرت أو ما زالت في مهلتها.', 'info');
    else notify(`تم تنفيذ المستحق: ${warnings} إنذار و ${bans} حرمان — وصلت الإشعارات للطلاب فورًا.`, 'success');
    void load();
  }

  const load = useCallback(async () => {
    setLoading(true);
    const [compliance, subjectList, dueSummary] = await Promise.all([
      getAttendanceCompliance(levelFilter || undefined, subjectFilter || undefined),
      database.from('subjects').select('id, name_ar, level, term').order('level').order('name_ar'),
      getLawDueSummary(),
    ]);
    if (compliance.error) notify(errorMessage(compliance.error, 'تعذر تحميل بيانات الالتزام بالحضور.'), 'error');
    setRows(compliance.data);
    const allSubjects = (subjectList.data as Subject[]) ?? [];
    setSubjects(scope.is_super ? allSubjects : allSubjects.filter((subject) => scope.subject_ids.includes(subject.id)));
    setDue(dueSummary.data);
    setLoading(false);
  }, [notify, levelFilter, subjectFilter, scope]);

  useEffect(() => { void load(); }, [load]);

  async function executeLaw(row: AttendanceComplianceRow) {
    const key = `${row.student_id}-${row.subject_id}`;
    const ordinal = row.warning_count + row.deduction_count + 1;
    const summary = `الحضور ${row.attendance_percent}% (${row.attended_sessions} من ${row.total_sessions}).\n\nالإجراء الحالي: ${ordinal <= 2 ? `إنذار ${ordinal === 1 ? 'أول' : 'ثانٍ'} للطالب` : 'خصم درجة كاملة من أعمال السنة (سريًا) + إعلان الحرمان للطالب'}.\n\nهل تريد تنفيذ القانون الآن؟`;
    if (!window.confirm(summary)) return;
    setBusyKey(key);
    const result = await executeAttendanceLaw(row.student_id, row.subject_id);
    setBusyKey(null);
    if (result.error) return notify(errorMessage(result.error, 'تعذر تنفيذ القانون.'), 'error');
    const action = result.data?.[0];
    if (action?.action_type === 'warning') notify(`تم إصدار إنذار ${action.action_number === 1 ? 'أول' : 'ثانٍ'} للطالب — سيظهر له التنبيه عند دخوله.`,
      'success');
    else notify('تم خصم درجة كاملة من الدرجات السرية، وأصبح الطالب محرومًا — يظهر له تنبيه الحرمان مع نص المادة ٣٥.', 'success');
    void load();
  }

  async function undo(row: AttendanceComplianceRow) {
    if (!window.confirm('إلغاء جميع الإنذارات والخصومات لهذا الطالب في هذه المادة؟ سيتم استعادة الدرجات المخصومة تلقائيًا.')) return;
    const key = `${row.student_id}-${row.subject_id}`;
    setBusyKey(key);
    const result = await undoAttendanceLaw(row.student_id, row.subject_id);
    setBusyKey(null);
    if (result.error) return notify(errorMessage(result.error, 'تعذر التراجع.'), 'error');
    notify('تم إلغاء الإجراءات.', 'info');
    void load();
  }

  const filtered = rows.filter((row) => !onlyViolators || row.below_minimum || row.warning_count > 0 || row.deduction_count > 0 || row.is_banned);

  return (
    <main className="content-area">
      <div className="page-intro">
        <div>
          <span className="eyebrow">الالتزام بالحضور</span>
          <h2>قانون الحضور ٣٥</h2>
          <p>{scope.is_super ? 'متابعة نسبة حضور كل طالب في كل مادة، وتنفيذ المادة ٣٥ (إنذاران ثم خصم وحرمان).' : `متابعة موادك فقط (${scope.subject_names.join('، ') || 'لا مواد'}) — الفرقة ${lockedLevels.join('، ') || '—'}: إنذاران ثم خصم وحرمان، ولا تظهر لك أي مادة أخرى.`}</p>
        </div>
        <div className="row-actions">
          <button className="secondary-button" disabled={scanBusy} onClick={() => void runDueScan(true)}>{scanBusy ? 'جارٍ الفحص…' : 'فحص تجريبي'}</button>
          <button className="primary-button" disabled={scanBusy || !due?.due_now} onClick={() => { if (window.confirm('تنفيذ كل الإجراءات المستحقة الآن؟\n\nسيصدر إنذار أول/ثانٍ لكل طالب تجاوز الحد، ثم الحرمان لمن استوفى الإنذارين ومهلتهما. لا يُخصم أي درجة تلقائيًا.')) void runDueScan(false); }}>
            <AlertTriangle size={16} /> تنفيذ المستحق الآن{due?.due_now ? ` (${due.due_now})` : ''}
          </button>
          <button className="text-button" onClick={() => setShowLaw((v) => !v)}>{showLaw ? 'إخفاء نص القانون' : 'نص القانون'}</button>
        </div>
      </div>
      {showLaw && <div className="notice-box"><AlertTriangle size={19} /><div><b>نص المادة كما هي</b><p>{LAW_TEXT}</p></div></div>}
      {due && <div className={due.due_now ? 'status-alert law-ban-alert' : 'notice-box'}><div className="alert-icon"><AlertTriangle size={20} /></div><div>
        <b>{due.due_now ? `التنبيه التلقائي: ${due.due_now} إجراء مستحق الآن وفق المادة ٣٥` : 'التنبيه التلقائي: لا يوجد إجراء مستحق الآن'}</b>
        <p>إنذارات مستحقة: {due.warnings_due} · حرمان مستحق: {due.deprivations_due} · إجراءات مؤجلة (مهلة أو نقص محاضرات): {due.blocked} · إجمالي المتأثرين: {due.total_violators} · محرومون حاليًا: {due.banned_total}</p>
        <small>المحرك التلقائي: حد أدنى {LAW_MIN_SESSIONS} محاضرات مغلقة، مهلة {LAW_COOLDOWN_DAYS} أيام بين كل إجراءين. لا يُخصم أي درجة تلقائيًا — الخصم بقرارك من الأزرار أدناه.</small>
      </div></div>}
      <div className="filter-bar" style={{ margin: '16px 0' }}>
        <select className="filter-select" value={levelFilter} onChange={(e) => setLevelFilter(Number(e.target.value) || '')} disabled={lockedLevels.length === 1}>
          {scope.is_super && <option value="">كل المراحل</option>}
          {adminLevelOptions(scope).map((level) => <option key={level} value={level}>الفرقة {level}</option>)}
        </select>
        <select className="filter-select" value={subjectFilter} onChange={(e) => setSubjectFilter(e.target.value)}>
          <option value="">كل المواد</option>
          {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name_ar} · الفرقة {subject.level}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--muted)' }}>
          <input type="checkbox" checked={onlyViolators} onChange={(e) => setOnlyViolators(e.target.checked)} />
          المخالفون فقط (تحت 75% أو عليهم إنذار/حرمان)
        </label>
        <button className="icon-button" onClick={() => void load()} title="تحديث"><RefreshCw size={17} /></button>
      </div>
      <div className="table-card">
        <div className="table-card-head">
          <div><span className="eyebrow">{filtered.length} صف</span><h3>حالة الالتزام بالحضور</h3></div>
          <span>الحد الأدنى: 75%</span>
        </div>
        {loading ? <InlineLoading /> : filtered.length === 0 ? (
          <EmptyState title="لا توجد مخالفات حاليًا" description="جميع الطلاب ملتزمون بنسبة الحضور المطلوبة، أو لا توجد محاضرات مغلقة بعد." />
        ) : (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>الطالب</th><th>الرقم</th><th>الفرقة</th><th>المادة</th>
                  <th>الحضور</th><th>النسبة</th><th>الإنذارات</th><th>الحالة</th><th>تنفيذ القانون</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const key = `${row.student_id}-${row.subject_id}`;
                  const ordinal = row.warning_count + row.deduction_count + 1;
                  return (
                    <tr key={key} style={row.is_banned ? { background: '#fef2f2' } : undefined}>
                      <td><b>{row.student_name}</b></td>
                      <td dir="ltr">{row.national_id}</td>
                      <td>{row.level}</td>
                      <td>{row.subject_name}</td>
                      <td>{row.attended_sessions}/{row.total_sessions}</td>
                      <td><b style={{ color: row.below_minimum ? '#b91c1c' : undefined }}>{row.attendance_percent}%</b></td>
                      <td>{row.warning_count + row.deduction_count}</td>
                      <td>{row.is_banned ? <span className="status-pill rejected">محروم</span> : row.below_minimum ? <span className="status-pill pending">تحت الحد</span> : <span className="status-pill approved">ملتزم</span>}</td>
                      <td>
                        <div className="row-actions">
                          <button className="approve-button" disabled={busyKey === key || row.total_sessions === 0} onClick={() => void executeLaw(row)}>
                            <Check size={15} /> {ordinal <= 2 ? `إنذار ${ordinal === 1 ? 'أول' : 'ثانٍ'}` : 'خصم + حرمان'}
                          </button>
                          {(row.warning_count > 0 || row.deduction_count > 0) && (
                            <button className="reject-button" disabled={busyKey === key} onClick={() => void undo(row)}>
                              <RotateCcw size={15} /> تراجع
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="notice-box">
        <AlertTriangle size={19} />
        <div>
          <b>آلية التنفيذ</b>
          <p>الإنذار الأول ثم الثاني: تنبيه يظهر للطالب مع كل دخول. من الإجراء الثالث: يُخصم اثنان وعشرون درجة من أعمال السنة (سريًا، دون إخبار الطالب) ويُعلن له الحرمان من دخول امتحان المادة فقط مع نص المادة ٣٥. الطلاب الملتزمون لا يتأثرون.</p>
        </div>
      </div>
    </main>
  );
}

// ─── إعدادات أدمن المادة: مثل الطالب بالضبط (الاسم عربي/إنجليزي + كلمة المرور)
// بلا أي وصول لإعدادات النظام (النطاق الجغرافي وغيره للمشرف العام فقط)،
// وبتغيير كلمة المرور عدد مرات غير محدود (الطالب محدود بـ3 مرات في الترم).
function AdminOwnSettings({ admin, scope, notify, onProfileSaved }: { admin: Admin; scope: AdminScope; notify: (message: string, type?: 'success' | 'error' | 'info') => void; onProfileSaved: (fullName: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [arName, setArName] = useState(scope.full_name_ar);
  const [enName, setEnName] = useState(scope.full_name_en);
  const [saveBusy, setSaveBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changeBusy, setChangeBusy] = useState(false);

  const passwordStrong = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(newPassword);

  async function saveName() {
    const ar = arName.trim().replace(/\s+/g, ' ');
    const en = enName.trim().replace(/\s+/g, ' ');
    if (ar.split(/\s+/).filter(Boolean).length < 2 || /[A-Za-z0-9]/.test(ar)) return notify('أدخل الاسم العربي كاملًا بحروف عربية فقط', 'error');
    if (!/^[A-Za-z][A-Za-z .]*$/.test(en) || en.split(/\s+/).filter(Boolean).length < 2) return notify('أدخل الاسم الإنجليزي كاملًا بحروف إنجليزية فقط', 'error');
    setSaveBusy(true);
    const result = await updateOwnAdminProfile(ar, en);
    setSaveBusy(false);
    if (result.error) return notify(errorMessage(result.error, 'تعذر حفظ الاسم.'), 'error');
    if (result.data && !result.data.ok) return notify(result.data.error ?? 'تعذر حفظ الاسم.', 'error');
    onProfileSaved(ar);
    setEditing(false);
    notify('تم تحديث اسمك، ويظهر الجديد في اللوحة وفي كل الكشوفات.', 'success');
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (!passwordStrong) return notify('كلمة المرور يجب أن تشمل حرفًا كبيرًا وصغيرًا ورقمًا ورمزًا (8 أحرف فأكثر).', 'error');
    if (newPassword !== confirmPassword) return notify('كلمتا المرور غير متطابقتين', 'error');
    setChangeBusy(true);
    const result = await changeOwnAdminPassword(currentPassword, newPassword);
    setChangeBusy(false);
    if (result.error) return notify(errorMessage(result.error, 'تعذر تغيير كلمة المرور.'), 'error');
    if (result.data && !result.data.ok) return notify(result.data.error ?? 'تعذر تغيير كلمة المرور.', 'error');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    notify('تم تغيير كلمة المرور بنجاح — وأُبطلت كل الجلسات القديمة.', 'success');
  }

  return <main className="content-area">
    <div className="page-intro">
      <div>
        <span className="eyebrow">بيانات حسابك</span>
        <h2>الإعدادات</h2>
        <p>غيّر اسمك وكلمة مرورك كما يفعل الطالب تمامًا — وبعدد مرات غير محدود.</p>
      </div>
    </div>
    <div className="profile-grid">
      <section className="table-card profile-card">
        <div className="profile-header">
          <div className="large-avatar">{admin.full_name.slice(0, 1)}</div>
          <div><h3>{admin.full_name}</h3><span>{admin.email}</span></div>
          <span className="status-pill approved">أدمن مادة</span>
        </div>
        <div className="detail-grid">
          {editing ? (
            <div className="stack-form full-width-field">
              <label>الاسم بالعربية<input value={arName} onChange={(e) => setArName(e.target.value)} dir="rtl" disabled={saveBusy} /></label>
              <label>الاسم بالإنجليزية<input value={enName} onChange={(e) => setEnName(e.target.value)} dir="ltr" disabled={saveBusy} /></label>
              <div className="form-actions">
                <button className="primary-button" disabled={saveBusy} onClick={() => void saveName()}>{saveBusy ? 'جارٍ الحفظ…' : 'حفظ الاسم'}</button>
                <button className="text-button" onClick={() => setEditing(false)} disabled={saveBusy}>إلغاء</button>
              </div>
            </div>
          ) : (
            <>
              <Detail label="الاسم بالعربية" value={scope.full_name_ar} />
              <Detail label="الاسم بالإنجليزية" value={scope.full_name_en} />
              <Detail label="البريد الإلكتروني" value={admin.email} ltr />
              <div className="full-width-field"><button className="text-button" onClick={() => setEditing(true)}>تعديل الاسم</button></div>
            </>
          )}
        </div>
      </section>
      <section className="table-card">
        <div className="table-card-head"><h3>نطاق حسابك</h3><span>{scope.subject_names.length} مادة</span></div>
        <div className="subject-list">
          {scope.subject_names.map((name) => <div className="subject-row" key={name}><div className="subject-number">{scope.levels.join('، ')}</div><div><b>{name}</b><small>موادك ومستواك فقط — بلا أي وصول لبقية المواد</small></div></div>)}
          {!scope.subject_names.length && <EmptyState title="بلا مواد مسندة" description="راجع المشرف العام لإسناد موادك." />}
        </div>
      </section>
    </div>
    <section className="table-card reset-card">
      <div className="security-symbol"><LockKeyhole size={23} /></div>
      <div>
        <h3>تغيير كلمة المرور</h3>
        <p>يمكنك تغيير كلمة مرورك بنفسك في أي وقت وبعدد مرات غير محدود (بخلاف الطالب المحدد بـ3 مرات في الترم).</p>
      </div>
      <form className="stack-form reset-form" onSubmit={changePassword}>
        <label>كلمة المرور الحالية<PasswordField value={currentPassword} onChange={setCurrentPassword} required autoComplete="current-password" /></label>
        <label>كلمة المرور الجديدة<PasswordField value={newPassword} onChange={setNewPassword} required minLength={8} />{newPassword && <small className={passwordStrong ? 'valid-hint' : 'error-hint'}>{passwordStrong ? 'مستوفية للشروط' : 'يجب أن تشمل حرفًا كبيرًا وصغيرًا ورقمًا ورمزًا'}</small>}</label>
        <label>تأكيد كلمة المرور الجديدة<PasswordField value={confirmPassword} onChange={setConfirmPassword} required minLength={8} /></label>
        <button className="primary-button" type="submit" disabled={changeBusy || !passwordStrong || newPassword !== confirmPassword}>{changeBusy ? 'جارٍ الحفظ…' : 'حفظ كلمة المرور'}</button>
      </form>
    </section>
  </main>;
}

function AdminSettings({ admin, notify, theme, setTheme }: { admin: Admin; notify: (message: string, type?: 'success' | 'error' | 'info') => void; theme?: 'modern' | 'classic'; setTheme?: (t: 'modern' | 'classic') => void }) {
  const [geo, setGeo] = useState<GeofenceConfig | null>(null);
  const [form, setForm] = useState({ label: '', latitude: '', longitude: '', radius_meters: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => { getGeofence().then((result) => { if (result.data) { setGeo(result.data); setForm({ label: result.data.label, latitude: String(result.data.latitude), longitude: String(result.data.longitude), radius_meters: String(result.data.radius_meters) }); } }); }, []);
  async function save() { setSaving(true); const result = await updateGeofence({ label: form.label, latitude: Number(form.latitude), longitude: Number(form.longitude), radius_meters: Number(form.radius_meters) }, admin.id); setSaving(false); if (result.error) return notify(errorMessage(result.error), 'error'); notify('تم حفظ إعدادات النطاق الجغرافي.', 'success'); }
  return <main className="content-area"><div className="page-intro"><div><span className="eyebrow">إعدادات الحماية</span><h2>إعدادات النظام</h2><p>تأكد من موقع مبنى الكلية قبل إطلاق التسجيل الفعلي.</p></div></div><div className="settings-grid"><section className="table-card"><div className="settings-heading"><div className="settings-icon"><MapPin size={21} /></div><div><h3>النطاق الجغرافي</h3><p>لا يُسمح بتسجيل الحضور من خارج هذا النطاق.</p></div></div><div className="stack-form"><label>اسم الموقع<input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} /></label><div className="two-fields"><label>خط العرض<input value={form.latitude} onChange={(event) => setForm({ ...form, latitude: event.target.value })} dir="ltr" /></label><label>خط الطول<input value={form.longitude} onChange={(event) => setForm({ ...form, longitude: event.target.value })} dir="ltr" /></label></div><label>نصف القطر بالمتر<input value={form.radius_meters} onChange={(event) => setForm({ ...form, radius_meters: event.target.value })} type="number" min={50} max={1000} dir="ltr" /></label><button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? 'جارٍ الحفظ…' : 'حفظ إعدادات الموقع'}</button></div>{geo && <div className="settings-footnote"><Globe2 size={15} /> الإحداثيات الحالية تقريبية، يرجى تثبيت Pin دقيق قبل التشغيل.</div>}</section><section className="table-card"><div className="settings-heading"><div className="settings-icon"><ShieldCheck size={21} /></div><div><h3>سياسات الأمان</h3><p>الحماية مفعّلة على جميع عمليات النظام.</p></div></div><div className="policy-list"><div><CheckCircle2 size={17} /><span>Row-Level Security على الجداول</span></div><div><CheckCircle2 size={17} /><span>الوقت من خادم قاعدة البيانات</span></div><div><CheckCircle2 size={17} /><span>لا يتم تخزين الصور الشخصية</span></div><div><CheckCircle2 size={17} /><span>الدرجات غير مرئية للطلاب</span></div><div><CheckCircle2 size={17} /><span>تسجيل تدقيق للتعديلات</span></div></div></section><section className="table-card" style={{ gridColumn: '1 / -1' }}><div className="settings-heading"><div className="settings-icon"><Palette size={21} /></div><div><h3>مظهر وإصدار الواجهة (الرجوع للنسخة الكلاسيكية)</h3><p>يمكنك التبديل بين التصميم الحديث (v2) أو الرجوع للنسخة الكلاسيكية الأصلية (v1) في أي وقت.</p></div></div><div style={{ padding: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}><div><b>المظهر المفعّل حاليًا:</b> {theme === 'classic' ? 'النسخة الكلاسيكية الأصلية (v1)' : 'النسخة الحديثة المطورة (v2)'}<p style={{ color: 'var(--muted)', fontSize: '13px', marginTop: '4px' }}>يتم حفظ اختيارك وتطبيقه على كل شاشات النظام فورًا دون المساس بالبيانات.</p></div>{setTheme && <button className={theme === 'classic' ? 'primary-button' : 'secondary-button'} onClick={() => { const next = theme === 'classic' ? 'modern' : 'classic'; setTheme(next); notify(next === 'classic' ? 'تم الرجوع للنسخة الكلاسيكية (v1).' : 'تم تفعيل النسخة الحديثة (v2).', 'success'); }}><RotateCcw size={16} /><span>{theme === 'classic' ? 'تفعيل النسخة الحديثة (v2)' : 'الرجوع للنسخة الكلاسيكية (v1)'}</span></button>}</div></section></div></main>;
}

// ─── لوحة الأدمن: طلبات إضافة المواد (موافقة أدمن المادة أو المشرف العام) ───
function AdminAddSubjectsQueue({ notify }: { notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [requests, setRequests] = useState<PendingAddSubjectRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    const result = await getPendingAddSubjectRequests();
    setLoading(false);
    if (result.error) return notify(errorMessage(result.error, 'تعذر تحميل طلبات المواد.'), 'error');
    setRequests(result.data);
  }, [notify]);
  useEffect(() => { void load(); }, [load]);

  async function decide(requestIds: string[], approve: boolean) {
    setBusyIds(new Set(requestIds));
    const result = await handleAddSubjectRequests(requestIds, approve);
    setBusyIds(new Set());
    if (result.error) return notify(errorMessage(result.error, 'تعذر تنفيذ الإجراء.'), 'error');
    notify(approve ? `تمت الموافقة وإضافة ${result.data} مادة للطلاب فورًا.` : 'تم رفض الطلبات.', 'success');
    void load();
  }

  // تجميع حسب الطالب حتى يوافق على مجموعة مواد طالب واحد دفعة واحدة.
  const byStudent = new Map<string, PendingAddSubjectRequest[]>();
  for (const request of requests) {
    const list = byStudent.get(request.student_id) ?? [];
    list.push(request);
    byStudent.set(request.student_id, list);
  }

  return <main className="content-area">
    <div className="page-intro">
      <div>
        <span className="eyebrow">موافقة الطالب</span>
        <h2>طلبات إضافة المواد</h2>
        <p>طلبات الطلاب لإضافة مواد جديدة في ترهم الحالي — تُفعّل فور الموافقة بنفس نظام الحضور والدرجات تمامًا. ترى فقط طلبات موادك (المشرف العام يرى الكل).</p>
      </div>
      <button className="icon-button" onClick={() => void load()} title="تحديث"><RefreshCw size={17} /></button>
    </div>
    <div className="table-card">
      {loading ? <InlineLoading /> : !requests.length ? <EmptyState title="لا توجد طلبات معلقة" description="ستظهر طلبات الطلاب هنا لحظة إرسالهم." /> : (
        <>
          <div className="table-card-head"><div><span className="eyebrow">{requests.length} طلب</span><h3>مجمّعة حسب الطالب</h3></div></div>
          <div className="responsive-table">
            <table>
              <thead><tr><th>الطالب</th><th>الرقم القومي</th><th>الفرقة</th><th>المواد المطلوبة</th><th>التاريخ</th><th>الإجراء</th></tr></thead>
              <tbody>
                {[...byStudent.entries()].map(([studentId, list]) => {
                  const isBusy = list.some((request) => busyIds.has(request.request_id));
                  return (
                    <tr key={studentId}>
                      <td><b>{list[0].student_name}</b><br /><small dir="ltr" style={{ color: 'var(--muted)' }}>{list[0].student_email}</small></td>
                      <td dir="ltr">{list[0].national_id}</td>
                      <td>الفرقة {list[0].level}</td>
                      <td>{list.map((request) => request.subject_name).join('، ')}</td>
                      <td>{new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(list[0].requested_at))}</td>
                      <td>
                        <div className="row-actions">
                          <button className="approve-button" disabled={isBusy} onClick={() => void decide(list.map((request) => request.request_id), true)}><Check size={15} /> موافقة</button>
                          <button className="reject-button" disabled={isBusy} onClick={() => void decide(list.map((request) => request.request_id), false)}><X size={15} /> رفض</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
    <div className="notice-box">
      <AlertTriangle size={19} />
      <div>
        <b>سير العمل</b>
        <p>الموافقة تُنشئ تسجيل المادة للطالب فورًا (بنفس آلية التسجيل الأول): الحضور يُفتح له في المحاضرات الجديدة، ودرجات أعمال السنة تُحسب تلقائيًا. الرفض يعلل الطلب ويمكن للطالب إعادة الإرسال لاحقًا.</p>
      </div>
    </div>
  </main>;
}

// ─── لوحة الأدمن العام: إدارة حسابات أدمن المواد ───
function AdminSubjectAdmins({ notify }: { notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [admins, setAdmins] = useState<SubjectAdminRow[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ fullName: '', email: '', password: '', subjectIds: [] as string[] });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [adminResult, subjectResult] = await Promise.all([listSubjectAdmins(), database.from('subjects').select('*').order('level').order('name_ar')]);
    setLoading(false);
    if (adminResult.error) return notify(errorMessage(adminResult.error, 'تعذر تحميل حسابات الأدمن.'), 'error');
    setAdmins(adminResult.data ?? []);
    setSubjects((subjectResult.data as Subject[]) ?? []);
  }, [notify]);
  useEffect(() => { void load(); }, [load]);

  async function submitCreate() {
    if (!form.fullName.trim() || !form.email.trim() || !form.subjectIds.length) return notify('املأ الاسم والبريد واختر مادة واحدة على الأقل.', 'error');
    if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(form.password)) return notify('كلمة المرور يجب أن تشمل حرفًا كبيرًا وصغيرًا ورقمًا ورمزًا (8 أحرف فأكثر).', 'error');
    if (!window.confirm(`إنشاء حساب أدمن لـ ${form.email.trim()}؟\nسيُسند إلى ${form.subjectIds.length} مادة ولن يرى غيرها.`)) return;
    setSaving(true);
    const result = await createSubjectAdmin({ email: form.email.trim(), password: form.password, fullName: form.fullName.trim(), subjectIds: form.subjectIds });
    setSaving(false);
    if (result.error) return notify(errorMessage(result.error, 'تعذر إنشاء الحساب.'), 'error');
    setAddOpen(false);
    setForm({ fullName: '', email: '', password: '', subjectIds: [] });
    notify('تم إنشاء حساب أدمن المادة — أمِله الباسورد عليه الآن.', 'success');
    void load();
  }

  async function reassign(admin: SubjectAdminRow, subjectIds: string[]) {
    if (!subjectIds.length) return notify('اختر مادة واحدة على الأقل.', 'error');
    const result = await setSubjectAdminSubjects(admin.admin_id, subjectIds);
    if (result.error) return notify(errorMessage(result.error, 'تعذر تحديث الإسناد.'), 'error');
    notify('تم تحديث المواد المسندة للأدمن.', 'success');
    void load();
  }

  // «طلبات تسجيل الطلاب» شاشة محجوبة عن أدمن المادة إلا بمنحة صريحة منك هنا.
  async function toggleRegistrations(admin: SubjectAdminRow) {
    const next = !admin.can_review_registrations;
    const confirmText = next
      ? `منح ${admin.full_name} صلاحية «طلبات تسجيل الطلاب»؟\nسيستطيع اعتماد ورفض الطلاب المسجلين في مواده فقط (${admin.levels.join('، ') || 'بلا فرق'}).`
      : `سحب صلاحية «طلبات تسجيل الطلاب» من ${admin.full_name}؟\nلن تظهر له الشاشة ولن يستطيع اعتماد أي طالب.`;
    if (!window.confirm(confirmText)) return;
    const result = await superSetAdminPermissions(admin.admin_id, next);
    if (result.error) return notify(errorMessage(result.error, 'تعذر تحديث الصلاحية.'), 'error');
    notify(next ? 'تم منح صلاحية طلبات تسجيل الطلاب.' : 'تم سحب صلاحية طلبات تسجيل الطلاب.', 'success');
    void load();
  }

  async function remove(admin: SubjectAdminRow) {
    if (!window.confirm(`حذف حساب ${admin.full_name} (${admin.email})؟\n\nلن يستطيع الدخول بعد ذلك، وسنفقد إسناد موادّه.`)) return;
    const result = await deleteSubjectAdmin(admin.admin_id);
    if (result.error) return notify(errorMessage(result.error, 'تعذر الحذف.'), 'error');
    notify('تم حذف الحساب.', 'success');
    void load();
  }

  return <main className="content-area">
    <div className="page-intro">
      <div>
        <span className="eyebrow">بمثابتك فقط (المشرف العام)</span>
        <h2>أدمن المواد</h2>
        <p>لكل مادة دكتور مسؤول: له حساب خاص يرى فيه مادته فقط (طلابها وحضورها ودرجاتها). أنت ترى كل شيء.</p>
      </div>
      <button className="primary-button" onClick={() => setAddOpen(true)}><UserPlus size={16} /> إضافة أدمن مادة</button>
    </div>
    <div className="table-card">
      {loading ? <InlineLoading /> : (
        <>
          <div className="table-card-head"><div><span className="eyebrow">{admins.length} حساب</span><h3>حسابات الأدمن</h3></div></div>
          <div className="responsive-table">
            <table>
              <thead><tr><th>الاسم</th><th>البريد</th><th>المواد المسندة</th><th>طلبات تسجيل الطلاب</th><th>أُنشئ في</th><th>إجراء</th></tr></thead>
              <tbody>
                {admins.map((admin) => {
                  const isSuper = admin.is_super;
                  return (
                    <tr key={admin.admin_id}>
                      <td><b>{admin.full_name}</b>{isSuper && <span className="status-pill approved" style={{ marginInlineStart: 8 }}>المشرف العام</span>}</td>
                      <td dir="ltr">{admin.email}</td>
                      <td>
                        <select
                          multiple
                          value={admin.subject_ids}
                          style={{ minWidth: 220, maxHeight: 90 }}
                          onChange={(event) => {
                            const selected = Array.from(event.target.selectedOptions).map((option) => option.value);
                            void reassign(admin, selected);
                          }}
                          title="اضغط Ctrl/Command لاختيار أكثر من مادة"
                        >
                          {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name_ar} · الفرقة {subject.level}</option>)}
                        </select>
                        <small style={{ display: 'block', marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>الفرق المسموح بها: {admin.levels.join('، ') || '—'}</small>
                      </td>
                      <td>
                        {isSuper ? <span className="status-pill approved">المشرف العام — كل الصلاحيات</span> : (
                          <button
                            className={admin.can_review_registrations ? 'approve-button' : 'secondary-button'}
                            style={{ padding: '6px 12px', fontSize: 12 }}
                            onClick={() => void toggleRegistrations(admin)}
                            title={admin.can_review_registrations ? 'سحب الصلاحية' : 'منح الصلاحية'}
                          >
                            {admin.can_review_registrations ? <><Check size={14} /> مُتاح</> : <><LockKeyhole size={14} /> محجوب</>}
                          </button>
                        )}
                      </td>
                      <td>{new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(new Date(admin.created_at))}</td>
                      <td>
                        {!isSuper && <button className="danger-solid-button" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => void remove(admin)}><Trash2 size={14} /> حذف</button>}
                      </td>
                    </tr>
                  );
                })}
                {!admins.length && <tr><td colSpan={6}><EmptyState title="لا توجد حسابات أدمن مواد" description="أضف حساب الدكتور المسؤول عن كل مادة من زر إضافة أعلاه." /></td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
    <div className="notice-box">
      <ShieldCheck size={19} />
      <div>
        <b>كيف يظهر لمواده؟</b>
        <p>كل حساب أدمن مادة يرى في الجلسات والدرجات والطلبات وقانون ٣٥ فقط المواد المسندة إليه — هذه آيضًا صارمة في قاعدة البيانات نفسها (وليس فقط في الواجهة).</p>
      </div>
    </div>

    {addOpen && (
      <div className="modal-overlay" onClick={() => { if (!saving) setAddOpen(false); }}>
        <div className="modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h3>إنشاء حساب أدمن مادة</h3>
            <button className="icon-button" onClick={() => setAddOpen(false)} disabled={saving}><X size={18} /></button>
          </div>
          <div className="modal-body">
            <p className="modal-subtitle">أدخل بيانات الدكتور وسنُسند إليه المواد. سيظهر له في لوحته فقط هذه المواد — ويرسل لك أنت الطلبات المتعلقة بها للمراجعة لاحقاً.</p>
            <div className="stack-form">
              <label>الاسم<input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} placeholder="د. محمد أحمد" disabled={saving} /></label>
              <label>البريد الإلكتروني<input type="email" dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="doctor@zu.edu.eg" disabled={saving} /></label>
              <label>كلمة المرور<input type="password" dir="ltr" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="8 أحرف فأكثر (كبيرة/صغيرة/رقم/رمز)" disabled={saving} /></label>
              <label>المواد المسندة
                <select multiple value={form.subjectIds} style={{ minHeight: 120 }} onChange={(e) => setForm({ ...form, subjectIds: Array.from(e.target.selectedOptions).map((option) => option.value) })} disabled={saving}>
                  {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name_ar} · الفرقة {subject.level}</option>)}
                </select>
              </label>
            </div>
          </div>
          <div className="modal-footer">
            <button className="secondary-button" onClick={() => setAddOpen(false)} disabled={saving}>إلغاء</button>
            <button className="primary-button" onClick={() => void submitCreate()} disabled={saving}>{saving ? <><span className="button-spinner" /> جارٍ الإنشاء…</> : 'إنشاء الحساب'}</button>
          </div>
        </div>
      </div>
    )}
  </main>;
}

function InlineLoading() { return <div className="inline-loading"><span className="spinner" /> جارٍ تحميل البيانات…</div>; }
function EmptyState({ title, description }: { title: string; description: string }) { return <div className="empty-state"><div className="empty-icon"><CircleHelp size={24} /></div><h3>{title}</h3><p>{description}</p></div>; }

export default App;
