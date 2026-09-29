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
  checkIn,
  errorMessage,
  executeAttendanceLaw,
  getActiveSessions,
  getAdminSessions,
  getAttendanceCompliance,
  getCurrentUser,
  getGeofence,
  getMyAttendanceStatus,
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
  signIn,
  signOut,
  undoAttendanceLaw,
  updateGeofence,
  updateStudentGrade,
  updateStudentStatus,
  validateNationalId,
  type AttendanceComplianceRow,
  type MyAttendanceStatusRow,
} from './lib/api';
import { parseWhitelistFile } from './lib/whitelist';
import { PrintableAttendanceSheet } from './components/admin/PrintableAttendanceSheet';
import { AdminAudioBeacon } from './components/admin/AdminAudioBeacon';
import { BulkPromotionPanel } from './components/admin/BulkPromotionPanel';
import { RepeaterReviewPanel } from './components/admin/RepeaterReviewPanel';
import { StudentAudioReceiver } from './components/student/StudentAudioReceiver';
import { EnrollmentStatus } from './components/student/EnrollmentStatus';
import { database, insforge } from './lib/insforge';
import { readCurrentLocation, supportsPasskeys } from './lib/device';
import type { AcademicTerm, Admin, AttendanceLog, GeofenceConfig, LectureSession, SecretGrade, Student, Subject, User } from './lib/types';
import { STATUS_LABELS, TERM_LABELS } from './lib/types';

type AuthView = 'login' | 'register';
type AdminTab = 'overview' | 'students' | 'passwords' | 'whitelist' | 'sessions' | 'grades' | 'promotion' | 'repeaters' | 'law35' | 'settings';
type StudentTab = 'dashboard' | 'attendance' | 'profile';

const publicRoutes: Record<AuthView, string> = {
  login: '/login',
  register: '/register',
};

const studentRoutes: Record<StudentTab, string> = {
  dashboard: '/student/dashboard',
  attendance: '/student/attendance',
  profile: '/student/profile',
};

const adminRoutes: Record<AdminTab, string> = {
  overview: '/admin/dashboard',
  students: '/admin/students',
  passwords: '/admin/passwords',
  whitelist: '/admin/whitelist',
  sessions: '/admin/sessions',
  grades: '/admin/grades',
  promotion: '/admin/promotion',
  repeaters: '/admin/repeaters',
  law35: '/admin/law35',
  settings: '/admin/settings',
};

function authViewFromPath(path: string): AuthView {
  if (path === publicRoutes.register) return 'register';
  return 'login';
}

function studentTabFromPath(path: string): StudentTab {
  if (path === studentRoutes.attendance) return 'attendance';
  if (path === studentRoutes.profile) return 'profile';
  return 'dashboard';
}

function adminTabFromPath(path: string): AdminTab {
  if (path === adminRoutes.students) return 'students';
  if (path === adminRoutes.passwords) return 'passwords';
  if (path === adminRoutes.whitelist) return 'whitelist';
  if (path === adminRoutes.sessions) return 'sessions';
  if (path === adminRoutes.grades) return 'grades';
  if (path === adminRoutes.promotion) return 'promotion';
  if (path === adminRoutes.repeaters) return 'repeaters';
  if (path === adminRoutes.law35) return 'law35';
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
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const { data, error } = await signIn(email.trim(), password);
    setBusy(false);
    if (error || !data?.user) return notify(errorMessage(error, 'تعذر تسجيل الدخول. راجع البريد وكلمة المرور.'), 'error');
    await onSignedIn(data.user as User);
    notify('مرحبًا بعودتك.', 'success');
  }
  return <><div className="form-heading"><span className="eyebrow">مرحبًا بعودتك</span><h2>تسجيل الدخول</h2><p>أدخل بيانات حسابك للوصول إلى لوحة الحضور.</p></div><form onSubmit={submit} className="stack-form"><label>البريد الإلكتروني<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@zu.edu.eg" required autoComplete="email" dir="ltr" /></label><label>كلمة المرور<div className="input-with-icon"><LockKeyhole size={17} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="أدخل كلمة المرور" required autoComplete="current-password" dir="ltr" /></div></label><button className="primary-button full" disabled={busy}>{busy ? <><span className="button-spinner" /> جارٍ الدخول…</> : <>دخول إلى الحساب <ArrowLeft size={17} /></>}</button></form><div className="auth-switch"><span>ليس لديك حساب؟</span><button onClick={onRegister}>إنشاء حساب طالب</button></div><div className="security-note"><Fingerprint size={20} /><span><b>دخول آمن</b><small>نستخدم تشفيرًا حديثًا ولا نخزّن أي صورة شخصية.</small></span></div></>;
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
  return <><div className="form-heading"><span className="eyebrow">خطوة {step} من 2</span><h2>إنشاء حساب طالب</h2><p>{step === 1 ? 'تحقق من الرقم القومي وأكمل بياناتك الأساسية.' : 'اختر المواد التي ستسجل حضورها هذا الترم.'}</p></div><div className="progress-line"><span className={step >= 1 ? 'active' : ''} /><span className={step >= 2 ? 'active' : ''} /></div>{step === 1 ? <form onSubmit={(event) => { event.preventDefault(); void loadAvailableSubjects(); }} className="stack-form"><label>الرقم القومي<input value={form.nationalId} onChange={(event) => update('nationalId', event.target.value.replace(/\D/g, '').slice(0, 14))} placeholder="الرقم القومي المصري أو الرقم المدني العماني" inputMode="numeric" maxLength={14} required dir="ltr" /></label><div className="two-fields"><label>الاسم بالعربية<input value={form.fullNameAr} onChange={(event) => update('fullNameAr', event.target.value)} required /></label><label>الاسم بالإنجليزية<input value={form.fullNameEn} onChange={(event) => update('fullNameEn', event.target.value)} required dir="ltr" /></label></div><div className="two-fields"><label>الفرقة<select value={form.level} onChange={(event) => update('level', Number(event.target.value))} disabled><option value={1}>الفرقة الأولى</option><option value={2}>الفرقة الثانية</option><option value={3}>الفرقة الثالثة</option><option value={4}>الفرقة الرابعة</option></select></label><label>الترم<select value={form.term} onChange={(event) => update('term', event.target.value as AcademicTerm)}><option value="term1">الترم الأول</option><option value="term2">الترم الثاني</option><option value="summer">الترم الصيفي</option></select></label></div><label>البريد الإلكتروني<input type="email" value={form.email} onChange={(event) => update('email', event.target.value)} placeholder="name@zu.edu.eg" required dir="ltr" /></label><label>كلمة مرور قوية<input type="password" value={form.password} onChange={(event) => update('password', event.target.value)} required minLength={8} dir="ltr" />{form.password && <small className={passwordStrong ? 'valid-hint' : 'error-hint'}>{passwordStrong ? 'كلمة المرور مستوفية للشروط' : 'يجب أن تشمل حرفًا كبيرًا وصغيرًا ورقمًا ورمزًا'}</small>}</label><button className="primary-button full" disabled={!passwordStrong}>متابعة لاختيار المواد <ArrowLeft size={17} /></button></form> : <form onSubmit={submit} className="stack-form"><div className="subject-picker">{subjects.length ? subjects.map((subject) => <label key={subject.id} className={`subject-option ${selected.includes(subject.id) ? 'selected' : ''}`}><input type="checkbox" checked={selected.includes(subject.id)} onChange={() => setSelected((current) => current.includes(subject.id) ? current.filter((id) => id !== subject.id) : [...current, subject.id])} /><span className="check-box">{selected.includes(subject.id) && <Check size={15} />}</span><span><b>{subject.name_ar}</b><small>{subject.level === form.level ? 'مادة مقررة' : 'مادة متاحة للترم الصيفي'}</small></span></label>) : <div className="empty-state compact">لا توجد مواد متاحة بهذه البيانات.</div>}</div><div className="passkey-callout"><Fingerprint size={24} /><div><b>تسجيل مفتاح الجهاز</b><p>سنطلب بصمة الهاتف أو Face ID لحماية تسجيل الحضور. لا نلتقط أو نخزن أي صورة.</p></div></div><button className="primary-button full" disabled={busy || !selected.length}>{busy ? <><span className="button-spinner" /> جارٍ إنشاء الحساب…</> : <>إنشاء الحساب <UserPlus size={17} /></>}</button><button type="button" className="text-button" onClick={() => setStep(1)}>العودة لتعديل البيانات</button></form>}<div className="auth-switch"><span>لديك حساب بالفعل؟</span><button onClick={onLogin}>تسجيل الدخول</button></div></>;
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
        <AppHeader title={tab === 'dashboard' ? 'الرئيسية' : tab === 'attendance' ? 'سجل الحضور' : 'الملف الشخصي'} subtitle={`أهلًا بك، ${student.full_name_ar.split(' ')[0]}`} onLogout={onLogout} onMenu={() => setMobileNav((current) => !current)} />
        {tab === 'dashboard' && <StudentDashboard student={student} notify={notify} onOpenAttendance={() => navigate(studentRoutes.attendance)} />}
        {tab === 'attendance' && <StudentAttendance student={student} />}
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
  const bannedSubjects = lawStatus.filter((row) => row.is_banned);
  const warnedSubjects = lawStatus.filter((row) => !row.is_banned && row.warning_count > 0);
  const lowSubjects = lawStatus.filter((row) => !row.is_banned && row.warning_count === 0 && row.attendance_percent < 75);
  return <main className="content-area"><div className="welcome-banner"><div><span className="eyebrow">لوحة الطالب</span><h2>أهلًا يا {student.full_name_ar.split(' ')[0]} <span>♪</span></h2><p>تابع محاضراتك وسجل حضورك بسهولة وأمان.</p></div><div className="banner-illustration"><div className="music-note note-one">♪</div><div className="music-note note-two">♫</div><div className="banner-circle" /></div></div><div className="stats-grid"><StatCard icon={<CalendarCheck />} label="إجمالي الحضور" value={String(attended)} hint="محاضرة مسجلة" tone="green" /><StatCard icon={<Clock3 />} label="جلسات متاحة الآن" value={String(activeSessions.length)} hint="بانتظار تسجيلك" tone="orange" /><StatCard icon={<GraduationCap />} label="المواد المسجلة" value={String(subjects.length)} hint={TERM_LABELS[student.term]} tone="blue" /></div>{bannedSubjects.length > 0 && <div className="status-alert law-ban-alert"><div className="alert-icon"><AlertTriangle size={21} /></div><div><b>تنبيه حرمان — {bannedSubjects.map((row) => row.subject_name).join('، ')}</b><p>{LAW_TEXT}</p></div></div>}{warnedSubjects.length > 0 && <div className="status-alert"><div className="alert-icon"><AlertTriangle size={21} /></div><div><b>إنذار حضور — {warnedSubjects.map((row) => `${row.subject_name} (${row.attendance_percent}%)`).join('، ')}</b><p>نسبة حضورك أقل من المطلوب (75%). انتظامك ضروري لتجنب الحرمان وفقًا للمادة ٣٥.</p></div></div>}{lowSubjects.length > 0 && <div className="status-alert"><div className="alert-icon"><Clock3 size={21} /></div><div><b>نسبة حضور منخفضة — {lowSubjects.map((row) => `${row.subject_name} (${row.attendance_percent}%)`).join('، ')}</b><p>حضورك أقل من 75% المطلوبة. انتظم في المحاضرات القادمة.</p></div></div>}{student.status !== 'approved' && <div className="status-alert"><div className="alert-icon"><Clock3 size={21} /></div><div><b>حسابك {STATUS_LABELS[student.status]}</b><p>{student.status === 'pending' ? 'يمكنك تجهيز ملفك الآن، وسيُفتح تسجيل الحضور بعد مراجعة الإدمن لبياناتك.' : 'يرجى مراجعة إدارة القسم لمعرفة حالة الحساب.'}</p></div></div>}{activeSessions.length > 0 && <section className="section-block"><div className="section-heading"><div><span className="eyebrow">متاح الآن</span><h3>محاضرات مفتوحة للتسجيل</h3></div><button className="text-button" onClick={onOpenAttendance}>عرض السجل <ArrowLeft size={15} /></button></div><div className="session-grid">{activeSessions.map((session) => <div className="session-card" key={session.id}><div className="session-top"><span className="live-dot"><span /> مباشر</span><span className="session-time">{new Intl.DateTimeFormat('ar-EG', { hour: '2-digit', minute: '2-digit' }).format(new Date(session.opened_at))}</span></div><h4>{session.subject?.name_ar ?? 'مادة دراسية'}</h4><p><MapPin size={15} /> البصمة + الموقع داخل الكلية، أو الصوت داخل القاعة</p><button className="primary-button full" disabled={checkingId === session.id || student.status !== 'approved'} onClick={() => void handleCheckIn(session)}>{checkingId === session.id ? <><span className="button-spinner" /> جارٍ التحقق…</> : <><Fingerprint size={17} /> تسجيل الحضور بالبصمة</>}</button>{session.is_attendance_active && student.status === 'approved' && <StudentAudioReceiver sessionId={session.id} notify={notify} onSuccess={() => void load()} />}</div>)}</div></section>}{activeSessions.length === 0 && <section className="empty-panel"><div className="empty-icon"><CalendarCheck size={27} /></div><h3>لا توجد محاضرات مفتوحة الآن</h3><p>سيظهر زر تسجيل الحضور هنا فور بدء الإدمن لمحاضرة تخص موادك.</p></section>}<section className="section-block"><div className="section-heading"><div><span className="eyebrow">أمان الحساب</span><h3>مفتاح جهازك</h3></div></div><div className="security-panel"><div className="security-symbol"><Fingerprint size={28} /></div><div><b>استخدم بصمة هاتفك أو جهازك اللوحي لتسجيل الحضور</b><p>لا نرى بصمتك ولا نخزن صورة وجهك. يحتفظ جهازك بالمفتاح الخاص، ويحتفظ النظام بمفتاح عام مشفّر فقط. الأجهزة اللوحية مدعومة بالكامل.</p></div><button className="secondary-button" onClick={() => void setupPasskey()} disabled={passkeyBusy}>{passkeyBusy ? 'جارٍ الربط…' : 'ربط الجهاز'}</button></div></section></main>;
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

function StudentProfile({ student, user, notify }: { student: Student; user: User; notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [resetBusy, setResetBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [arName, setArName] = useState(student.full_name_ar);
  const [enName, setEnName] = useState(student.full_name_en);
  const [saveBusy, setSaveBusy] = useState(false);

  const [resetRequest, setResetRequest] = useState<any>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

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
    <div><h3>إعادة تعيين كلمة المرور</h3><p>يمكنك إرسال طلب إلى الإدمن. الحد الأقصى 3 طلبات في الترم الواحد.</p></div>
    
    {resetRequest?.status === 'pending' ? (
      <div className="status-alert"><p>طلبك قيد المراجعة من الإدمن...</p></div>
    ) : resetRequest?.status === 'approved' ? (
      <form className="stack-form reset-form" onSubmit={applyNewPassword}>
        <div className="status-alert"><p>تمت الموافقة! أدخل كلمة المرور الجديدة أدناه.</p></div>
        <label>كلمة المرور الجديدة<input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={8} dir="ltr" />{newPassword && <small className={passwordStrong ? 'valid-hint' : 'error-hint'}>{passwordStrong ? 'مستوفية للشروط' : 'يجب أن تشمل حرفًا كبيرًا وصغيرًا ورقمًا ورمزًا'}</small>}</label>
        <label>تأكيد كلمة المرور<input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required minLength={8} dir="ltr" /></label>
        <button className="primary-button" type="submit" disabled={resetBusy || !passwordStrong}>{resetBusy ? 'جارٍ الحفظ...' : 'تأكيد وحفظ'}</button>
      </form>
    ) : (
      <button className="secondary-button" disabled={resetBusy} onClick={() => void requestReset()}>{resetBusy ? 'جارٍ الإرسال...' : 'إرسال طلب'}</button>
    )}
  </section>
</main>;
}

function Detail({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) { return <div className="detail"><span>{label}</span><b dir={ltr ? 'ltr' : undefined}>{value}</b></div>; }

function AdminShell({ admin, path, navigate, notify, onLogout, theme, setTheme }: { admin: Admin; path: string; navigate: (path: string, replace?: boolean) => void; notify: (message: string, type?: 'success' | 'error' | 'info') => void; onLogout: () => void; theme?: 'modern' | 'classic'; setTheme?: (t: 'modern' | 'classic') => void }) {
  const tab = adminTabFromPath(path);
  const [mobileNav, setMobileNav] = useState(false);
  const tabs: Array<{ id: AdminTab; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: 'نظرة عامة', icon: <LayoutDashboard size={19} /> },
    { id: 'students', label: 'طلبات تسجيل الطلاب', icon: <Users size={19} /> },
    { id: 'passwords', label: 'طلبات تعيين المرور', icon: <LockKeyhole size={19} /> },
    { id: 'whitelist', label: 'الأرقام المسموح لها بالتسجيل', icon: <ClipboardList size={19} /> },
    { id: 'sessions', label: 'الجلسات والحضور', icon: <Activity size={19} /> },
    { id: 'grades', label: 'سجل الدرجات السري', icon: <BarChart3 size={19} /> },
    { id: 'promotion', label: 'ترقية المنتظمين', icon: <GraduationCap size={19} /> },
    { id: 'repeaters', label: 'مراجعة الراسبين', icon: <AlertTriangle size={19} /> },
    { id: 'law35', label: 'قانون الحضور ٣٥', icon: <ClipboardList size={19} /> },
    { id: 'settings', label: 'الإعدادات', icon: <Settings2 size={19} /> },
  ];
  return (
    <div className="app-layout admin-layout">
      <div className={`sidebar-backdrop ${mobileNav ? 'active' : ''}`} onClick={() => setMobileNav(false)} aria-hidden="true" />
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <SidebarBrand />
        <div className="admin-label"><ShieldCheck size={15} /> لوحة الإدمن</div>
        <nav>
          {tabs.map((item) => (
            <button key={item.id} className={tab === item.id ? 'nav-active' : ''} onClick={() => { navigate(adminRoutes[item.id]); setMobileNav(false); }}>
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="mini-profile">
            <div className="avatar admin-avatar">{admin.full_name.slice(0, 1)}</div>
            <span><b>{admin.full_name}</b><small>مدير النظام</small></span>
          </div>
          <div className="privacy-badge"><ShieldCheck size={15} /> صلاحيات كاملة</div>
        </div>
      </aside>
      <div className="main-column">
        <AppHeader title={tabs.find((item) => item.id === tab)?.label ?? ''} subtitle={`مرحبًا، ${admin.full_name}`} onLogout={onLogout} onMenu={() => setMobileNav((current) => !current)} />
        {tab === 'overview' && <AdminOverview admin={admin} notify={notify} onNavigate={(nextTab) => navigate(adminRoutes[nextTab])} />}
        {tab === 'students' && <AdminStudents notify={notify} />}
        {tab === 'passwords' && <AdminPasswords notify={notify} />}
        {tab === 'whitelist' && <AdminWhitelist notify={notify} />}
        {tab === 'sessions' && <AdminSessions admin={admin} notify={notify} />}
        {tab === 'grades' && <AdminGrades notify={notify} />}
        {tab === 'promotion' && <BulkPromotionPanel notify={notify} />}
        {tab === 'repeaters' && <RepeaterReviewPanel notify={notify} />}
        {tab === 'law35' && <AdminAttendanceLaw notify={notify} />}
        {tab === 'settings' && <AdminSettings admin={admin} notify={notify} theme={theme} setTheme={setTheme} />}
        <SiteFooter />
      </div>
      <nav className="mobile-bottom-nav admin-bottom-nav" aria-label="التنقل السريع للإدمن">
        <button className={tab === 'overview' ? 'active' : ''} onClick={() => { navigate(adminRoutes.overview); setMobileNav(false); }}>
          <LayoutDashboard size={20} />
          <span>الرئيسية</span>
        </button>
        <button className={tab === 'students' ? 'active' : ''} onClick={() => { navigate(adminRoutes.students); setMobileNav(false); }}>
          <Users size={20} />
          <span>الطلاب</span>
        </button>
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

function AdminOverview({ admin, notify, onNavigate }: { admin: Admin; notify: (message: string, type?: 'success' | 'error' | 'info') => void; onNavigate: (tab: AdminTab) => void }) {
  const [students, setStudents] = useState<Student[]>([]);
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [logs, setLogs] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => { Promise.all([getStudents(), getAdminSessions()]).then(([studentsResult, sessionsResult]) => { setStudents(studentsResult.data); setSessions(sessionsResult.data); }); }, []);
  const pending = students.filter((item) => item.status === 'pending').length;
  const active = sessions.filter((item) => item.is_active).length;
  const approved = students.filter((item) => item.status === 'approved').length;
  useEffect(() => { database.from('attendance_logs').select('id,checked_in_at,student_id').order('checked_in_at', { ascending: false }).limit(5).then(({ data }) => setLogs((data as Array<Record<string, unknown>>) ?? [])); }, []);
  return <main className="content-area"><div className="admin-hero"><div><span className="eyebrow">ملخص النظام</span><h2>لوحة التحكم <em>في إيقاع واحد.</em></h2><p>تابع اعتماد الطلاب، الجلسات المفتوحة، وسجل الحضور من مكان واحد.</p></div><div className="admin-hero-icon"><BarChart3 size={50} strokeWidth={1.3} /></div></div><div className="stats-grid admin-stats"><StatCard icon={<Users />} label="إجمالي الطلاب" value={String(students.length)} hint={`${approved} حساب معتمد`} tone="green" /><StatCard icon={<Clock3 />} label="حسابات معلقة" value={String(pending)} hint="تحتاج مراجعتك" tone="orange" /><StatCard icon={<Activity />} label="جلسات نشطة" value={String(active)} hint="تسجل الآن" tone="blue" /><StatCard icon={<ShieldCheck />} label="حالة الحماية" value="مفعلة" hint="RLS + Passkeys" tone="purple" /></div><div className="dashboard-columns"><section className="table-card"><div className="table-card-head"><div><span className="eyebrow">تحتاج انتباهك</span><h3>طلبات التسجيل</h3></div><button className="text-button" onClick={() => onNavigate('students')}>كل الطلاب <ArrowLeft size={15} /></button></div>{students.filter((item) => item.status === 'pending').slice(0, 4).map((item) => <div className="pending-row" key={item.id}><div className="avatar small-avatar">{item.full_name_ar.slice(0, 1)}</div><div><b>{item.full_name_ar}</b><small>الفرقة {item.level} · {item.national_id}</small></div><span className="status-pill pending">معلق</span></div>)}{!pending && <EmptyState title="لا توجد طلبات معلقة" description="جميع الحسابات تمت مراجعتها." />}</section><section className="table-card"><div className="table-card-head"><div><span className="eyebrow">الآن</span><h3>الجلسات الحالية</h3></div><button className="text-button" onClick={() => onNavigate('sessions')}>إدارة <ArrowLeft size={15} /></button></div>{sessions.filter((item) => item.is_active).slice(0, 3).map((session) => <div className="active-session-row" key={session.id}><span className="live-dot"><span /> مباشر</span><div><b>{session.subject?.name_ar}</b><small>بدأت {new Intl.DateTimeFormat('ar-EG', { timeStyle: 'short' }).format(new Date(session.opened_at))}</small></div><ChevronDown size={17} /></div>)}{!active && <EmptyState title="لا توجد جلسات مفتوحة" description="ابدأ جلسة جديدة من صفحة الجلسات." />}</section></div><div className="quick-actions"><button onClick={() => onNavigate('students')}><UserCheck size={20} /><span><b>مراجعة الطلبات</b><small>اعتماد حسابات الطلاب</small></span><ArrowLeft size={17} /></button><button onClick={() => onNavigate('sessions')}><Activity size={20} /><span><b>فتح محاضرة</b><small>بدء تسجيل حضور مباشر</small></span><ArrowLeft size={17} /></button><button onClick={() => onNavigate('grades')}><FileSpreadsheet size={20} /><span><b>تصدير الدرجات</b><small>إلى Google Sheets</small></span><ArrowLeft size={17} /></button></div>{logs.length > 0 && <div className="sr-only">آخر حضور: {String(logs[0].checked_in_at)} بواسطة {admin.email}</div>}</main>;
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

  async function handleReset(requestId: string, approve: boolean) {
    const res = await insforge.functions.invoke('admin-reset-password', { body: { request_id: requestId, approve } });
    if (res.error) return notify(res.error.message || 'خطأ', 'error');
    notify(approve ? 'تمت الموافقة على طلب إعادة التعيين.' : 'تم رفض الطلب.', 'success');
    load();
  }

  return (
    <main className="content-area">
      <div className="page-intro">
        <div><span className="eyebrow">إدارة المستخدمين</span><h2>طلبات تعيين المرور</h2><p>راجع طلبات إعادة تعيين كلمة المرور المعلقة.</p></div>
        <button className="icon-button" onClick={() => void load()} title="تحديث"><RefreshCw size={17} /></button>
      </div>
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
                        <button className="approve-button" onClick={() => void handleReset(req.id, true)}><Check size={15} /> موافقة</button>
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

function AdminStudents({ notify }: { notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [students, setStudents] = useState<Student[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [levelFilter, setLevelFilter] = useState<number | ''>('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => { 
    setLoading(true); 
    const result = await getStudents();
    if (result.error) notify(errorMessage(result.error), 'error'); 
    setStudents(result.data || []); 
    setLoading(false); 
  }, [notify]);
  
  useEffect(() => { void load(); }, [load]);

  async function changeStatus(student: Student, status: 'approved' | 'rejected') { 
    const result = await updateStudentStatus(student.id, status); 
    if (result.error) return notify(errorMessage(result.error, 'تعذر تحديث حالة الحساب.'), 'error'); 
    notify(status === 'approved' ? 'تم اعتماد حساب الطالب.' : 'تم رفض الطلب.', 'success'); 
    void load(); 
  }
  
  const [purgingId, setPurgingId] = useState<string | null>(null);
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

  const filtered = students.filter((item) => (filter === 'all' || item.status === filter) && (levelFilter === '' || item.level === levelFilter) && [item.full_name_ar, item.full_name_en, item.national_id, item.email].some((value) => value.toLowerCase().includes(search.toLowerCase())));

  return <main className="content-area"><div className="page-intro"><div><span className="eyebrow">إدارة المستخدمين</span><h2>طلبات تسجيل الطلاب</h2><p>راجع طلبات تسجيل الطلاب وحالات الحسابات واعتمد المعلق منها.</p></div></div><div className="filter-bar"><div className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="بحث بالاسم أو الرقم القومي…" /></div><div className="filter-tabs">{[['all', 'الكل'], ['pending', 'معلق'], ['approved', 'معتمد'], ['rejected', 'مرفوض']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value as typeof filter)}>{label}<span>{value === 'all' ? students.length : students.filter((student) => student.status === value).length}</span></button>)}</div><select className="filter-select" value={levelFilter} onChange={e => setLevelFilter(Number(e.target.value) || '')}><option value="">جميع الفرق</option><option value={1}>الفرقة الأولى</option><option value={2}>الفرقة الثانية</option><option value={3}>الفرقة الثالثة</option><option value={4}>الفرقة الرابعة</option></select><button className="icon-button" onClick={() => void load()} title="تحديث"><RefreshCw size={17} /></button></div><div className="table-card">
        {loading ? <InlineLoading /> : <><div className="table-card-head"><div><span className="eyebrow">الحسابات</span><h3>طلبات تسجيل الطلاب</h3></div></div><div className="responsive-table"><table><thead><tr><th>الطالب</th><th>الرقم القومي</th><th>الفرقة والترم</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id}><td><div className="table-person"><div className="avatar small-avatar">{item.full_name_ar.slice(0, 1)}</div><span><b>{item.full_name_ar}</b><small dir="ltr">{item.email}</small></span></div></td><td dir="ltr">{item.national_id}</td><td>الفرقة {item.level} · {TERM_LABELS[item.term]}</td><td><span className={`status-pill ${item.status}`}>{STATUS_LABELS[item.status]}</span></td><td>{item.status === 'pending' ? <div className="row-actions"><button className="approve-button" onClick={() => void changeStatus(item, 'approved')}><Check size={15} /> اعتماد</button><button className="reject-button" onClick={() => void changeStatus(item, 'rejected')}><X size={15} /></button></div> : <span className="muted">—</span>}<button className="danger-solid-button" disabled={purgingId === item.id} onClick={() => void purgeStudent(item)} title="حذف نهائي من النظام بالكامل" style={{ padding: '6px 12px', fontSize: '12px' }}>{purgingId === item.id ? 'جارٍ الحذف…' : <><Trash2 size={14} /> حذف نهائي</>}</button></td></tr>)}</tbody></table>{!filtered.length && <EmptyState title="لا توجد نتائج" description="جرّب تغيير كلمات البحث أو الفلتر." />}</div></>}</div></main>;
}

function AdminWhitelist({ notify }: { notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [whitelist, setWhitelist] = useState<Array<{ national_id: string; full_name_reference: string | null; level: number | null; is_claimed: boolean }>>([]);
  const [levelFilter, setLevelFilter] = useState<number | ''>('');
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
  const filteredWhitelist = whitelist.filter(item => levelFilter === '' || item.level === levelFilter);
  return (
    <main className="content-area">
      <div className="page-intro">
        <div>
          <span className="eyebrow">إدارة التسجيل</span>
          <h2>الأرقام المسموح لها بالتسجيل</h2>
          <p>قائمة الأرقام القومية المعتمدة للتسجيل في الكلية. استورد ملفًا لإضافة أرقام جديدة.</p>
        </div>
        <>
          <input ref={uploadRef} type="file" accept=".csv,.xlsx" hidden onChange={(event) => void importWhitelist(event.target.files?.[0])} />
          <button className="secondary-button" onClick={() => uploadRef.current?.click()}><Download size={17} /> استيراد قائمة الأرقام</button>
        </>
      </div>
      <div className="filter-bar">
        <select className="filter-select" value={levelFilter} onChange={e => setLevelFilter(Number(e.target.value) || '')}>
          <option value="">جميع الفرق</option>
          <option value={1}>الفرقة الأولى</option>
          <option value={2}>الفرقة الثانية</option>
          <option value={3}>الفرقة الثالثة</option>
          <option value={4}>الفرقة الرابعة</option>
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
                    <td><button className="danger-solid-button" disabled={purging === item.national_id} onClick={() => void purgeEntry(item)} title={item.is_claimed ? 'حذف الطالب نهائيًا من النظام بالكامل' : 'حذف الرقم نهائيًا من القائمة'} style={{ padding: '6px 12px', fontSize: '12px' }}>{purging === item.national_id ? 'جارٍ الحذف…' : <><Trash2 size={14} /> حذف نهائي</>}</button></td>
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

function AdminSessions({ admin, notify }: { admin: Admin; notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [attendance, setAttendance] = useState<Array<Record<string, unknown>>>([]);
  const load = useCallback(async () => { setLoading(true); const [sessionResult, subjectResult] = await Promise.all([getAdminSessions(), database.from('subjects').select('*').order('level').order('name_ar')]); setSessions(sessionResult.data); setSubjects((subjectResult.data as Subject[]) ?? []); setLoading(false); }, []);
  useEffect(() => { void load(); }, [load]);
  async function startSession() { if (!selected) return notify('اختر المادة أولًا.', 'error'); const result = await openLecture(selected, admin.id); if (result.error) return notify(errorMessage(result.error), 'error'); notify('تم بدء المحاضرة ويمكن للطلاب تسجيل الحضور الآن.', 'success'); setSelected(''); void load(); }
  async function endSession(sessionId: string) { const result = await database.from('lecture_sessions').update({ is_active: false, closed_at: new Date().toISOString() }).eq('id', sessionId); if (result.error) return notify(errorMessage(result.error), 'error'); notify('تم إنهاء المحاضرة وإغلاق التسجيل.', 'success'); void load(); }
  async function viewAttendance(sessionId: string) { const result = await getSessionAttendance(sessionId); if (result.error) notify(errorMessage(result.error), 'error'); setAttendance((result.data as Array<Record<string, unknown>>) ?? []); }
  useEffect(() => { let disposed = false; insforge.realtime.connect().then(() => insforge.realtime.subscribe('attendance-live')).catch(() => undefined); const refresh = window.setInterval(() => { if (!disposed) void load(); }, 10000); return () => { disposed = true; window.clearInterval(refresh); insforge.realtime.unsubscribe('attendance-live'); }; }, [load]);
  const active = sessions.filter((session) => session.is_active);
  return <main className="content-area"><div className="page-intro"><div><span className="eyebrow">تشغيل المحاضرات</span><h2>الجلسات والحضور</h2><p>ابدأ محاضرة، راقب التسجيل لحظيًا، ثم أغلق الجلسة عند الانتهاء.</p></div><span className="realtime-chip"><span /> تحديث لحظي</span></div><section className="open-session-panel"><div><span className="eyebrow">جلسة جديدة</span><h3>بدء محاضرة</h3><p>اختر المادة ثم افتح التسجيل للطلاب المعتمدين.</p></div><div className="session-launch"><select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">اختر المادة…</option>{subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name_ar} · الفرقة {subject.level}</option>)}</select><button className="primary-button" onClick={() => void startSession()}><Activity size={17} /> بدء المحاضرة</button></div></section><div className="section-heading standalone"><div><span className="eyebrow">المحاضرات</span><h3>الجلسات المفتوحة والمغلقة</h3></div><button className="icon-button" onClick={() => void load()}><RefreshCw size={17} /></button></div><div className="session-admin-grid">{loading ? <InlineLoading /> : sessions.map((session) => <div className={`admin-session-card ${session.is_active ? 'active' : 'closed'}`} key={session.id}><div className="session-top"><span className={session.is_active ? 'live-dot' : 'closed-dot'}>{session.is_active ? <><span /> مباشر</> : 'مغلقة'}</span><span>{new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(new Date(session.opened_at))}</span></div><h4>{session.subject?.name_ar}</h4><div className="session-meta"><span><Clock3 size={14} /> {new Intl.DateTimeFormat('ar-EG', { timeStyle: 'short' }).format(new Date(session.opened_at))}</span><span><Users size={14} /> التسجيلات تظهر هنا</span></div><div className="session-actions"><button className="secondary-button" onClick={() => void viewAttendance(session.id)}>عرض الحضور</button>{session.is_active && <button className="danger-button" onClick={() => void endSession(session.id)}>إنهاء</button>} <button className="danger-solid-button" style={{ opacity: 0.95 }} onClick={async () => { if (typeof window !== 'undefined' && window.confirm('هل أنت متأكد من حذف الجلسة نهائياً؟ سيتم حذف جميع سجلات الحضور المرتبطة بها.')) { const res = await insforge.functions.invoke('delete-session-permanently', { body: { session_id: session.id } }); if (res.error) notify(res.error.message || 'حدث خطأ', 'error'); else { notify('تم حذف الجلسة بنجاح', 'success'); load(); } } }}>حذف نهائي</button></div></div>)}</div>{sessions.filter((session) => session.is_active).map((session) => <AdminAudioBeacon key={`beacon-${session.id}`} sessionId={session.id} subjectId={session.subject_id} active={session.is_active} beaconActive={!!session.is_attendance_active} frequency={session.audio_token_frequency} notify={notify} onChanged={() => void load()} />)}{attendance.length > 0 && <div className="table-card attendance-live-table"><div className="table-card-head"><h3>حضور الجلسة المحددة</h3><span>{attendance.length} طالب</span></div><div className="responsive-table"><table><thead><tr><th>الطالب</th><th>الرقم القومي</th><th>وقت التسجيل</th><th>المسافة</th></tr></thead><tbody>{attendance.map((row) => { const person = row.students as { full_name_ar?: string; national_id?: string } | undefined; return <tr key={String(row.id)}><td>{person?.full_name_ar ?? 'طالب'}</td><td dir="ltr">{person?.national_id ?? '—'}</td><td>{new Intl.DateTimeFormat('ar-EG', { timeStyle: 'medium' }).format(new Date(String(row.checked_in_at)))} </td><td>{Math.round(Number(row.distance_meters) || 0)} م</td></tr>; })}</tbody></table></div></div>}</main>;
}

function AdminGrades({ notify }: { notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [level, setLevel] = useState<number | ''>('');
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
      insforge.database.from('subjects').select('*').eq('level', level).then(res => setSubjects((res.data as Subject[]) || []));
      setSubjectId('');
    } else {
      setSubjects([]);
      setSubjectId('');
    }
  }, [level]);

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
          <span className="eyebrow">للمدير فقط</span>
          <h2>سجل الدرجات السري</h2>
          <p>تُحسب أعمال السنة من نسبة الحضور مع إمكانية التعديل اليدوي.</p>
        </div>
        <div className="page-actions">
          <select className="filter-select" value={level} onChange={e => setLevel(Number(e.target.value) || '')}>
            <option value="">اختر الفرقة...</option>
            <option value={1}>الفرقة الأولى</option>
            <option value={2}>الفرقة الثانية</option>
            <option value={3}>الفرقة الثالثة</option>
            <option value={4}>الفرقة الرابعة</option>
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

function AdminAttendanceLaw({ notify }: { notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [rows, setRows] = useState<AttendanceComplianceRow[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [levelFilter, setLevelFilter] = useState<number | ''>('');
  const [subjectFilter, setSubjectFilter] = useState<string>('');
  const [onlyViolators, setOnlyViolators] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showLaw, setShowLaw] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [compliance, subjectList] = await Promise.all([
      getAttendanceCompliance(levelFilter || undefined, subjectFilter || undefined),
      database.from('subjects').select('id, name_ar, level, term').order('level').order('name_ar'),
    ]);
    if (compliance.error) notify('تعذر تحميل بيانات الالتزام بالحضور.', 'error');
    setRows(compliance.data);
    setSubjects((subjectList.data as Subject[]) ?? []);
    setLoading(false);
  }, [notify, levelFilter, subjectFilter]);

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
          <p>متابعة نسبة حضور كل طالب في كل مادة، وتنفيذ المادة ٣٥ (إنذاران ثم خصم وحرمان).</p>
        </div>
        <button className="text-button" onClick={() => setShowLaw((v) => !v)}>{showLaw ? 'إخفاء نص القانون' : 'نص القانون'}</button>
      </div>
      {showLaw && <div className="notice-box"><AlertTriangle size={19} /><div><b>نص المادة كما هي</b><p>{LAW_TEXT}</p></div></div>}
      <div className="filter-bar" style={{ margin: '16px 0' }}>
        <select className="filter-select" value={levelFilter} onChange={(e) => setLevelFilter(Number(e.target.value) || '')}>
          <option value="">كل المراحل</option>
          {[1, 2, 3, 4].map((level) => <option key={level} value={level}>الفرقة {level}</option>)}
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

function AdminSettings({ admin, notify, theme, setTheme }: { admin: Admin; notify: (message: string, type?: 'success' | 'error' | 'info') => void; theme?: 'modern' | 'classic'; setTheme?: (t: 'modern' | 'classic') => void }) {
  const [geo, setGeo] = useState<GeofenceConfig | null>(null);
  const [form, setForm] = useState({ label: '', latitude: '', longitude: '', radius_meters: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => { getGeofence().then((result) => { if (result.data) { setGeo(result.data); setForm({ label: result.data.label, latitude: String(result.data.latitude), longitude: String(result.data.longitude), radius_meters: String(result.data.radius_meters) }); } }); }, []);
  async function save() { setSaving(true); const result = await updateGeofence({ label: form.label, latitude: Number(form.latitude), longitude: Number(form.longitude), radius_meters: Number(form.radius_meters) }, admin.id); setSaving(false); if (result.error) return notify(errorMessage(result.error), 'error'); notify('تم حفظ إعدادات النطاق الجغرافي.', 'success'); }
  return <main className="content-area"><div className="page-intro"><div><span className="eyebrow">إعدادات الحماية</span><h2>إعدادات النظام</h2><p>تأكد من موقع مبنى الكلية قبل إطلاق التسجيل الفعلي.</p></div></div><div className="settings-grid"><section className="table-card"><div className="settings-heading"><div className="settings-icon"><MapPin size={21} /></div><div><h3>النطاق الجغرافي</h3><p>لا يُسمح بتسجيل الحضور من خارج هذا النطاق.</p></div></div><div className="stack-form"><label>اسم الموقع<input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} /></label><div className="two-fields"><label>خط العرض<input value={form.latitude} onChange={(event) => setForm({ ...form, latitude: event.target.value })} dir="ltr" /></label><label>خط الطول<input value={form.longitude} onChange={(event) => setForm({ ...form, longitude: event.target.value })} dir="ltr" /></label></div><label>نصف القطر بالمتر<input value={form.radius_meters} onChange={(event) => setForm({ ...form, radius_meters: event.target.value })} type="number" min={50} max={1000} dir="ltr" /></label><button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? 'جارٍ الحفظ…' : 'حفظ إعدادات الموقع'}</button></div>{geo && <div className="settings-footnote"><Globe2 size={15} /> الإحداثيات الحالية تقريبية، يرجى تثبيت Pin دقيق قبل التشغيل.</div>}</section><section className="table-card"><div className="settings-heading"><div className="settings-icon"><ShieldCheck size={21} /></div><div><h3>سياسات الأمان</h3><p>الحماية مفعّلة على جميع عمليات النظام.</p></div></div><div className="policy-list"><div><CheckCircle2 size={17} /><span>Row-Level Security على الجداول</span></div><div><CheckCircle2 size={17} /><span>الوقت من خادم قاعدة البيانات</span></div><div><CheckCircle2 size={17} /><span>لا يتم تخزين الصور الشخصية</span></div><div><CheckCircle2 size={17} /><span>الدرجات غير مرئية للطلاب</span></div><div><CheckCircle2 size={17} /><span>تسجيل تدقيق للتعديلات</span></div></div></section><section className="table-card" style={{ gridColumn: '1 / -1' }}><div className="settings-heading"><div className="settings-icon"><Palette size={21} /></div><div><h3>مظهر وإصدار الواجهة (الرجوع للنسخة الكلاسيكية)</h3><p>يمكنك التبديل بين التصميم الحديث (v2) أو الرجوع للنسخة الكلاسيكية الأصلية (v1) في أي وقت.</p></div></div><div style={{ padding: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}><div><b>المظهر المفعّل حاليًا:</b> {theme === 'classic' ? 'النسخة الكلاسيكية الأصلية (v1)' : 'النسخة الحديثة المطورة (v2)'}<p style={{ color: 'var(--muted)', fontSize: '13px', marginTop: '4px' }}>يتم حفظ اختيارك وتطبيقه على كل شاشات النظام فورًا دون المساس بالبيانات.</p></div>{setTheme && <button className={theme === 'classic' ? 'primary-button' : 'secondary-button'} onClick={() => { const next = theme === 'classic' ? 'modern' : 'classic'; setTheme(next); notify(next === 'classic' ? 'تم الرجوع للنسخة الكلاسيكية (v1).' : 'تم تفعيل النسخة الحديثة (v2).', 'success'); }}><RotateCcw size={16} /><span>{theme === 'classic' ? 'تفعيل النسخة الحديثة (v2)' : 'الرجوع للنسخة الكلاسيكية (v1)'}</span></button>}</div></section></div></main>;
}

function InlineLoading() { return <div className="inline-loading"><span className="spinner" /> جارٍ تحميل البيانات…</div>; }
function EmptyState({ title, description }: { title: string; description: string }) { return <div className="empty-state"><div className="empty-icon"><CircleHelp size={24} /></div><h3>{title}</h3><p>{description}</p></div>; }

export default App;
