import { useCallback, useEffect, useState } from 'react';
import { Activity, Globe2, LogIn, MapPin, RefreshCw, Search, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import {
  errorMessage,
  getAdminAuditFacets,
  getAdminAuditLogs,
  getAdminLoginEvents,
  getAdminSecuritySummary,
  type AuditFacets,
  type AuditLogRow,
  type LoginEventRow,
  type SecuritySummary,
} from '../../lib/api';

const PAGE_SIZE = 50;

/** ترجمة أسماء الأفعال المسجلة في audit_logs إلى عربية واضحة. */
const ACTION_LABELS: Record<string, string> = {
  INSERT: 'إضافة سجل',
  UPDATE: 'تعديل سجل',
  DELETE: 'حذف سجل',
  admin_add_retro_attendance: 'إضافة حضور لجلسة سابقة',
  admin_remove_attendance: 'حذف سجل حضور',
  admin_set_student_password: 'تعيين كلمة مرور طالب',
  admin_update_own_profile: 'تعديل المشرف لبياناته',
  admin_update_student_name: 'تعديل اسم طالب',
  add_subject_approve: 'اعتماد طلب إضافة مادة',
  add_subject_reject: 'رفض طلب إضافة مادة',
  set_subject_admin_subjects: 'إسناد مواد لأدمن مادة',
  super_set_admin_permissions: 'تعديل صلاحيات أدمن',
  revoke_user_sessions: 'إلغاء جلسات مستخدم',
  execute_attendance_law: 'تنفيذ قانون الحضور ٣٥',
  undo_attendance_law: 'تراجع عن إجراء قانون ٣٥',
  law35_auto_warning: 'إنذار تلقائي (قانون ٣٥)',
  law35_auto_deprivation: 'حرمان تلقائي (قانون ٣٥)',
  student_change_own_password: 'الطالب غيّر كلمة مروره',
  student_add_subject_request: 'طلب طالب إضافة مادة',
  import_national_ids: 'استيراد أرقام قومية',
  update_geofence: 'تعديل النطاق الجغرافي',
};

function actionLabel(action: string) {
  return ACTION_LABELS[action] ?? action;
}

const METHOD_LABELS: Record<string, string> = {
  password: 'كلمة مرور',
  register: 'إنشاء حساب',
  passkey: 'بصمة/PASSKEY',
  google: 'Google',
};

const ROLE_LABELS: Record<string, string> = {
  admin: 'أدمن',
  student: 'طالب',
  unknown: 'غير معروف',
};

const KIND_LABELS: Record<string, string> = {
  admin: 'أدمن',
  student: 'طالب',
  system: 'النظام',
};

function fmtDateTime(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ar-EG', {
    dateStyle: 'full',
    timeStyle: 'medium',
    timeZone: 'Africa/Cairo',
  }).format(new Date(value));
}

function fmtRelative(value: string | null) {
  if (!value) return '—';
  const diffSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1],
  ];
  const formatter = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' });
  for (const [unit, seconds] of units) {
    if (Math.abs(diffSeconds) >= seconds || unit === 'second') {
      return formatter.format(Math.round(diffSeconds / seconds), unit);
    }
  }
  return '—';
}

/** الإحداثيات والأرقام التقنية تُعرض بأرقام لاتينية لتكون قابلة للنسخ والمقارنة. */
function fmtNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);
}

function accountName(row: LoginEventRow) {
  return row.display_name ?? row.identity ?? 'حساب غير معروف';
}

/** لا نكرر البريد إذا كان هو نفسه المعرّف المعروض كاسم. */
function accountSecondary(row: LoginEventRow) {
  if (row.email && row.email !== accountName(row)) return row.email;
  if (row.user_id) return row.user_id;
  return row.email;
}

/** تحويل تاريخين محليين (YYYY-MM-DD) إلى نطاق زمني كامل بتوقيت المستخدم. */
function toRange(fromDate: string, toDate: string) {
  const from = fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : null;
  const to = toDate ? new Date(new Date(`${toDate}T00:00:00`).getTime() + 86399999).toISOString() : null;
  return { from, to };
}

function DetailRow({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return <div className="audit-detail-row"><dt>{label}</dt><dd className={mono ? 'mono' : undefined}>{children}</dd></div>;
}

function SecurityCard({ icon, label, value, hint, tone }: { icon: React.ReactNode; label: string; value: string; hint: string; tone: string }) {
  return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{hint}</small></div></div>;
}

export function AdminAuditLog({ notify }: { notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [view, setView] = useState<'logins' | 'operations'>('logins');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [actorId, setActorId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [logins, setLogins] = useState<LoginEventRow[]>([]);
  const [operations, setOperations] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [facets, setFacets] = useState<AuditFacets>({ actions: [], entities: [], actors: [] });
  const [detail, setDetail] = useState<{ kind: 'login'; row: LoginEventRow } | { kind: 'operation'; row: AuditLogRow } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (reset = true, startAt = 0) => {
    if (reset) setLoading(true); else setLoadingMore(true);
    const range = toRange(fromDate, toDate);
    const offset = reset ? 0 : startAt;
    if (view === 'logins') {
      const { data, error } = await getAdminLoginEvents({
        search: debouncedSearch, status, role, from: range.from, to: range.to, limit: PAGE_SIZE, offset,
      });
      if (error) notify(errorMessage(error, 'تعذر تحميل سجل الدخول.'), 'error');
      setLogins((current) => (reset ? data : [...current, ...data]));
      setTotal(data[0]?.total_count ?? 0);
    } else {
      const { data, error } = await getAdminAuditLogs({
        search: debouncedSearch, action, entityType, actorId, from: range.from, to: range.to, limit: PAGE_SIZE, offset,
      });
      if (error) notify(errorMessage(error, 'تعذر تحميل سجل العمليات.'), 'error');
      setOperations((current) => (reset ? data : [...current, ...data]));
      setTotal(data[0]?.total_count ?? 0);
    }
    setLoading(false);
    setLoadingMore(false);
  }, [view, debouncedSearch, status, role, action, entityType, actorId, fromDate, toDate, notify]);

  const loadOverview = useCallback(async () => {
    const [summaryResult, facetsResult] = await Promise.all([getAdminSecuritySummary(), getAdminAuditFacets()]);
    if (summaryResult.data) setSummary(summaryResult.data);
    if (facetsResult.data) setFacets(facetsResult.data);
  }, []);

  useEffect(() => { void load(true); }, [load]);
  useEffect(() => { void loadOverview(); }, [loadOverview]);

  function refresh() {
    void load(true);
    void loadOverview();
  }

  function switchView(next: 'logins' | 'operations') {
    setView(next);
    setSearch('');
    setDebouncedSearch('');
    setStatus('');
    setRole('');
    setAction('');
    setEntityType('');
    setActorId('');
  }

  const shown = view === 'logins' ? logins.length : operations.length;
  const hasMore = shown < total;

  return <main className="content-area">
    <div className="page-intro">
      <div>
        <span className="eyebrow">لوحة تقنية — المشرف العام فقط</span>
        <h2>سجل العمليات</h2>
        <p>كل من دخل النظام ومتى وبأي ساعة ومن أي شبكة وجهاز وموقع، وكل تعديل جرى على البيانات: من نفّذه، على أي سجل، وبأي تفاصيل. السجل للقراءة فقط ولا يمكن تعديله أو حذفه من الواجهة.</p>
      </div>
      <div className="row-actions">
        <button className="secondary-button" onClick={refresh} disabled={loading}><RefreshCw size={16} /> تحديث</button>
      </div>
    </div>

    {summary && <div className="stats-grid audit-stats">
      <SecurityCard icon={<LogIn />} label="دخول ناجح (٢٤ ساعة)" value={String(summary.logins_24h)} hint={`الإجمالي ${summary.total_logins}`} tone="green" />
      <SecurityCard icon={<ShieldAlert />} label="محاولات فاشلة (٢٤ ساعة)" value={String(summary.failed_24h)} hint={`الإجمالي ${summary.total_failed}`} tone="orange" />
      <SecurityCard icon={<Globe2 />} label="عناوين شبكة مختلفة" value={String(summary.ips_24h)} hint="آخر ٢٤ ساعة" tone="blue" />
      <SecurityCard icon={<Activity />} label="أجهزة مختلفة" value={String(summary.devices_24h)} hint="آخر ٢٤ ساعة" tone="red" />
      <SecurityCard icon={<MapPin />} label="دخول بموقع GPS" value={String(summary.gps_24h)} hint="إحداثيات مؤكدة" tone="green" />
      <SecurityCard icon={<ShieldCheck />} label="عمليات مسجلة" value={String(summary.actions_24h)} hint={`٧ أيام: ${summary.actions_7d}`} tone="blue" />
    </div>}

    {summary && <div className="notice-box audit-last">
      <ShieldCheck size={18} />
      <div>
        <b>آخر دخول ناجح: {fmtDateTime(summary.last_login_at)} <span className="muted">({fmtRelative(summary.last_login_at)})</span></b>
        <p>آخر محاولة فاشلة: {fmtDateTime(summary.last_failed_at)} — أدمن نشط اليوم: {summary.admins_24h} · طالب نشط اليوم: {summary.students_24h}</p>
      </div>
    </div>}

    <div className="filter-bar">
      <div className="filter-tabs audit-views">
        <button className={view === 'logins' ? 'active' : ''} onClick={() => switchView('logins')}><LogIn size={15} /> الدخول والأجهزة</button>
        <button className={view === 'operations' ? 'active' : ''} onClick={() => switchView('operations')}><Activity size={15} /> العمليات على البيانات</button>
      </div>
    </div>

    <div className="filter-bar">
      <div className="search-box">
        <Search size={17} />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={view === 'logins' ? 'بحث بالاسم أو البريد أو IP أو المدينة أو الجهاز…' : 'بحث بالمنفّذ أو نوع الكيان أو التفاصيل…'}
        />
      </div>
      {view === 'logins' ? <>
        <select className="filter-select" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">كل النتائج</option>
          <option value="success">دخول ناجح</option>
          <option value="failed">محاولة فاشلة</option>
        </select>
        <select className="filter-select" value={role} onChange={(event) => setRole(event.target.value)}>
          <option value="">كل الحسابات</option>
          <option value="admin">أدمن</option>
          <option value="student">طالب</option>
        </select>
      </> : <>
        <select className="filter-select" value={action} onChange={(event) => setAction(event.target.value)}>
          <option value="">كل الأفعال</option>
          {facets.actions.map((item) => <option key={item.value} value={item.value}>{actionLabel(item.value)} ({item.count})</option>)}
        </select>
        <select className="filter-select" value={entityType} onChange={(event) => setEntityType(event.target.value)}>
          <option value="">كل الجداول</option>
          {facets.entities.map((item) => <option key={item.value} value={item.value}>{item.value} ({item.count})</option>)}
        </select>
        <select className="filter-select" value={actorId} onChange={(event) => setActorId(event.target.value)}>
          <option value="">كل المنفّذين</option>
          {facets.actors.map((item) => <option key={`${item.id}-${item.kind}`} value={item.id}>{item.name} — {KIND_LABELS[item.kind] ?? item.kind} ({item.count})</option>)}
        </select>
      </>}
      <label className="audit-date"><span>من</span><input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} /></label>
      <label className="audit-date"><span>إلى</span><input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} /></label>
      {(fromDate || toDate || search) && <button className="text-button" onClick={() => { setFromDate(''); setToDate(''); setSearch(''); }}>مسح الفلاتر</button>}
    </div>

    <div className="table-card">
      <div className="table-card-head">
        <div><span className="eyebrow">{view === 'logins' ? 'سجل الدخول' : 'سجل التدقيق'}</span><h3>{view === 'logins' ? 'من دخل، متى، ومن أين' : 'كل عملية على البيانات'}</h3></div>
        <span className="muted">{loading ? 'جارٍ التحميل…' : `${total} حدث`}</span>
      </div>
      {loading ? <div className="inline-loading"><span className="spinner" /> جارٍ تحميل السجل…</div> : view === 'logins' ? (
        logins.length === 0 ? <p className="muted audit-empty">لا توجد أحداث دخول مطابقة بعد. سيظهر هنا كل دخول بمجرد أن يسجّل أحدهم الدخول من النسخة المنشورة.</p> : (
          <div className="responsive-table">
            <table>
              <thead><tr><th>الوقت</th><th>الحساب</th><th>النتيجة</th><th>الطريقة</th><th>الشبكة والموقع</th><th>الجهاز</th><th>تفاصيل</th></tr></thead>
              <tbody>
                {logins.map((row) => <tr key={row.id}>
                  <td><b>{fmtDateTime(row.created_at)}</b><small className="muted" dir="ltr">{new Date(row.created_at).toISOString()}</small><small className="muted">{fmtRelative(row.created_at)}</small></td>
                  <td>
                    <div className="table-person">
                      <div className="avatar small-avatar">{(row.display_name ?? row.identity ?? '؟').slice(0, 1)}</div>
                      <span>
                        <b>{accountName(row)}</b>
                        <small dir="ltr">{accountSecondary(row) ?? '—'}</small>
                        <small>{ROLE_LABELS[row.role] ?? row.role}</small>
                      </span>
                    </div>
                  </td>
                  <td><span className={`status-pill ${row.status === 'success' ? 'approved' : 'rejected'}`}>{row.status === 'success' ? 'ناجح' : 'فاشل'}</span>{row.failure_reason && <small className="muted">{row.failure_reason}</small>}</td>
                  <td>{METHOD_LABELS[row.method] ?? row.method}</td>
                  <td>
                    <b dir="ltr">{row.ip ?? '—'}</b>
                    <small>{row.geo_source === 'gps' ? 'موقع GPS مؤكد' : row.country ? [row.city, row.region, row.country].filter(Boolean).join('، ') : 'لا يوجد موقع'}</small>
                    {row.geo_source === 'gps' && row.latitude !== null && row.longitude !== null && <a className="text-button" dir="ltr" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${row.latitude},${row.longitude}`}>خريطة</a>}
                  </td>
                  <td><span className="audit-device" dir="ltr" title={row.user_agent ?? ''}>{(row.user_agent ?? '—').slice(0, 42)}{(row.user_agent?.length ?? 0) > 42 ? '…' : ''}</span><small>{row.screen ?? ''}</small></td>
                  <td><button className="icon-button" onClick={() => setDetail({ kind: 'login', row })} title="عرض كل التفاصيل">⋯</button></td>
                </tr>)}
              </tbody>
            </table>
          </div>
        )
      ) : (
        operations.length === 0 ? <p className="muted audit-empty">لا توجد عمليات مطابقة للفلاتر.</p> : (
          <div className="responsive-table">
            <table>
              <thead><tr><th>الوقت</th><th>المنفّذ</th><th>العملية</th><th>الجدول / السجل</th><th>تفاصيل</th></tr></thead>
              <tbody>
                {operations.map((row) => <tr key={row.id}>
                  <td><b>{fmtDateTime(row.created_at)}</b><small className="muted" dir="ltr">{new Date(row.created_at).toISOString()}</small><small className="muted">{fmtRelative(row.created_at)}</small></td>
                  <td>
                    <div className="table-person">
                      <div className="avatar small-avatar">{(row.actor_name ?? 'ن').slice(0, 1)}</div>
                      <span>
                        <b>{row.actor_name ?? 'النظام'}</b>
                        <small dir="ltr">{row.actor_email ?? row.actor_id ?? '—'}</small>
                        <small>{KIND_LABELS[row.actor_kind] ?? row.actor_kind}</small>
                      </span>
                    </div>
                  </td>
                  <td><b>{actionLabel(row.action)}</b><small className="muted" dir="ltr">{row.action}</small></td>
                  <td><b dir="ltr">{row.entity_type}</b><small className="muted" dir="ltr">{row.entity_id ?? '—'}</small></td>
                  <td><button className="icon-button" onClick={() => setDetail({ kind: 'operation', row })} title="عرض التفاصيل الكاملة">⋯</button></td>
                </tr>)}
              </tbody>
            </table>
          </div>
        )
      )}
      {hasMore && !loading && <div className="audit-more"><button className="secondary-button" disabled={loadingMore} onClick={() => void load(false, shown)}>{loadingMore ? 'جارٍ التحميل…' : `تحميل المزيد (${total - shown} متبقٍ)`}</button></div>}
    </div>

    {detail?.kind === 'login' && (
      <div className="modal-overlay" onClick={() => setDetail(null)}>
        <div className="modal-card audit-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <h3>تفاصيل حدث الدخول</h3>
            <button className="icon-button" onClick={() => setDetail(null)}><X size={18} /></button>
          </div>
          <div className="modal-body">
            <dl className="audit-detail">
              <DetailRow label="التاريخ والوقت (توقيت القاهرة)">{fmtDateTime(detail.row.created_at)}</DetailRow>
              <DetailRow label="التوقيت العالمي ISO" mono>{new Date(detail.row.created_at).toISOString()}</DetailRow>
              <DetailRow label="المنطقة الزمنية المسجلة">{detail.row.timezone ?? '—'}</DetailRow>
              <DetailRow label="منذ">{fmtRelative(detail.row.created_at)}</DetailRow>
              <DetailRow label="الحساب">{accountName(detail.row)} ({ROLE_LABELS[detail.row.role] ?? detail.row.role})</DetailRow>
              <DetailRow label="البريد / المعرّف" mono>{detail.row.email ?? detail.row.identity ?? '—'}</DetailRow>
              <DetailRow label="معرّف المستخدم" mono>{detail.row.user_id ?? '—'}</DetailRow>
              <DetailRow label="النتيجة"><span className={`status-pill ${detail.row.status === 'success' ? 'approved' : 'rejected'}`}>{detail.row.status === 'success' ? 'دخول ناجح' : 'فاشل'}</span></DetailRow>
              <DetailRow label="سبب الفشل">{detail.row.failure_reason ?? '—'}</DetailRow>
              <DetailRow label="طريقة الدخول">{METHOD_LABELS[detail.row.method] ?? detail.row.method}</DetailRow>
              <DetailRow label="IP" mono>{detail.row.ip ?? '—'}</DetailRow>
              <DetailRow label="X-Forwarded-For" mono>{detail.row.forwarded_for ?? '—'}</DetailRow>
              <DetailRow label="مصدر الموقع">{detail.row.geo_source === 'gps' ? 'إحداثيات GPS من المتصفح' : detail.row.geo_source === 'ip' ? 'تقدير من عنوان الشبكة' : 'غير متاح'}</DetailRow>
              <DetailRow label="خط العرض" mono><span dir="ltr">{fmtNumber(detail.row.latitude)}</span></DetailRow>
              <DetailRow label="خط الطول" mono><span dir="ltr">{fmtNumber(detail.row.longitude)}</span></DetailRow>
              <DetailRow label="دقة الموقع (متر)" mono><span dir="ltr">{fmtNumber(detail.row.accuracy_m)}</span></DetailRow>
              <DetailRow label="المدينة / المنطقة">{detail.row.city ?? '—'} / {detail.row.region ?? '—'}</DetailRow>
              <DetailRow label="الدولة">{detail.row.country ?? '—'} {detail.row.country_code ? `(${detail.row.country_code})` : ''}</DetailRow>
              <DetailRow label="مزوّد الشبكة">{detail.row.org ?? '—'}</DetailRow>
              <DetailRow label="الجهاز (User-Agent)" mono>{detail.row.user_agent ?? '—'}</DetailRow>
              <DetailRow label="النظام / المنصة">{detail.row.platform ?? '—'}</DetailRow>
              <DetailRow label="لغة المتصفح">{detail.row.language ?? '—'}</DetailRow>
              <DetailRow label="مقاس الشاشة" mono>{detail.row.screen ?? '—'}</DetailRow>
              <DetailRow label="معرّف الحدث" mono>{detail.row.id}</DetailRow>
            </dl>
            {detail.row.latitude !== null && detail.row.longitude !== null && (
              <div className="row-actions audit-map-links">
                <a className="secondary-button" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${detail.row.latitude},${detail.row.longitude}`}>فتح الموقع على خرائط Google</a>
                <a className="secondary-button" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${detail.row.latitude}&mlon=${detail.row.longitude}#map=17/${detail.row.latitude}/${detail.row.longitude}`}>OpenStreetMap</a>
              </div>
            )}
          </div>
          <div className="modal-footer"><button className="secondary-button" onClick={() => setDetail(null)}>إغلاق</button></div>
        </div>
      </div>
    )}

    {detail?.kind === 'operation' && (
      <div className="modal-overlay" onClick={() => setDetail(null)}>
        <div className="modal-card audit-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <h3>تفاصيل العملية</h3>
            <button className="icon-button" onClick={() => setDetail(null)}><X size={18} /></button>
          </div>
          <div className="modal-body">
            <dl className="audit-detail">
              <DetailRow label="الوقت (توقيت القاهرة)">{fmtDateTime(detail.row.created_at)}</DetailRow>
              <DetailRow label="ISO" mono>{new Date(detail.row.created_at).toISOString()}</DetailRow>
              <DetailRow label="الفعل">{actionLabel(detail.row.action)}</DetailRow>
              <DetailRow label="كود الفعل" mono>{detail.row.action}</DetailRow>
              <DetailRow label="الجدول" mono>{detail.row.entity_type}</DetailRow>
              <DetailRow label="معرّف السجل" mono>{detail.row.entity_id ?? '—'}</DetailRow>
              <DetailRow label="المنفّذ">{detail.row.actor_name ?? 'النظام'} ({KIND_LABELS[detail.row.actor_kind] ?? detail.row.actor_kind})</DetailRow>
              <DetailRow label="بريد المنفّذ" mono>{detail.row.actor_email ?? '—'}</DetailRow>
              <DetailRow label="معرّف المنفّذ" mono>{detail.row.actor_id ?? '—'}</DetailRow>
              <DetailRow label="معرّف الحدث" mono>{detail.row.id}</DetailRow>
            </dl>
            <h4 className="audit-json-title">البيانات التفصيلية (metadata)</h4>
            <pre className="audit-json" dir="ltr">{JSON.stringify(detail.row.metadata ?? {}, null, 2)}</pre>
          </div>
          <div className="modal-footer"><button className="secondary-button" onClick={() => setDetail(null)}>إغلاق</button></div>
        </div>
      </div>
    )}
  </main>;
}
