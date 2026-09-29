import { useCallback, useEffect, useState } from 'react';
import { Check, Upload, X } from 'lucide-react';
import { database, insforge } from '../../lib/insforge';
import { errorMessage } from '../../lib/api';
import { parseRepeaterFile } from '../../lib/repeater';

type Submission = {
  id: string; national_id: string; student_name_ar: string | null;
  self_reported_case: 'parallel' | 'deferred'; failed_subject_ids: string[] | null;
  student_id: string | null; admin_decision: string | null;
};

export function RepeaterReviewPanel({ notify }: { notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [subjects, setSubjects] = useState<Array<{ id: string; name_ar: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [year, setYear] = useState('');
  const [term, setTerm] = useState('term1');

  const load = useCallback(async () => {
    setLoading(true);
    const [subRes, subjRes] = await Promise.all([
      database.from('repeater_form_submissions').select('*').is('admin_decision', null).order('submitted_at', { ascending: false }),
      database.from('subjects').select('id, name_ar'),
    ]);
    setSubmissions((subRes.data as Submission[]) ?? []);
    setSubjects((subjRes.data as Array<{ id: string; name_ar: string }>) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const subjectName = (id: string) => subjects.find((s) => s.id === id)?.name_ar ?? '—';

  async function importFile(file: File | undefined) {
    if (!file) return;
    if (!year.trim()) return notify('أدخل السنة الدراسية أولًا.', 'error');
    try {
      const parsed = await parseRepeaterFile(file);
      if (!parsed.length) throw new Error('لم نجد بيانات صالحة في الملف.');
      const result = await insforge.functions.invoke('import-repeater-submissions', {
        body: { academic_year: year.trim(), term_applying_for: term, rows: parsed },
      });
      if (result.error) notify(errorMessage(result.error, 'تعذر الاستيراد.'), 'error');
      else {
        notify(`تم استيراد ${result.data?.inserted_count ?? 0} طالب${result.data?.errors_count ? ` (${result.data.errors_count} بها مشاكل)` : ''}.`, 'success');
        void load();
      }
    } catch (error) { notify(errorMessage(error, 'تعذر قراءة الملف.'), 'error'); }
  }

  async function execute(sub: Submission, decision: 'approved' | 'rejected', correctedCase?: 'parallel' | 'deferred', correctedSubjects?: string[]) {
    setBusyId(sub.id);
    try {
      const result = await insforge.functions.invoke('execute-progression', {
        body: {
          submission_id: sub.id,
          final_decision: decision,
          final_case: correctedCase,
          final_subject_ids: correctedSubjects,
        },
      });
      if (result.error) notify(errorMessage(result.error, 'تعذر تنفيذ القرار.'), 'error');
      else { notify(result.data?.message ?? 'تم التنفيذ', 'success'); void load(); }
    } catch (error) { notify(errorMessage(error, 'تعذر تنفيذ القرار.'), 'error'); }
    setBusyId(null);
  }

  return (
    <section className="table-card">
      <div className="table-card-head">
        <div><span className="eyebrow">منطقة العزل</span><h3>مراجعة حالات الراسبين</h3></div>
        <span>{submissions.length} طلبات قيد المراجعة</span>
      </div>

      <div style={{ padding: '20px 22px 14px' }}>
        <div className="filter-bar" style={{ marginBottom: '16px' }}>
          <input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            placeholder="السنة الدراسية (مثال: 2025-2026)"
            dir="ltr"
            style={{ maxWidth: '240px' }}
          />
          <select value={term} onChange={(e) => setTerm(e.target.value)} style={{ maxWidth: '160px' }}>
            <option value="term1">الترم الأول</option>
            <option value="term2">الترم الثاني</option>
            <option value="summer">الترم الصيفي</option>
          </select>
          <label className="secondary-button" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <Upload size={16} />
            <span>استيراد استمارة الراسبين (CSV / XLSX)</span>
            <input type="file" accept=".csv,.xlsx" hidden onChange={(e) => void importFile(e.target.files?.[0])} />
          </label>
        </div>
      </div>

      {loading ? (
        <div className="inline-loading"><span className="spinner" /> جارٍ التحميل…</div>
      ) : submissions.length === 0 ? (
        <div className="empty-state" style={{ margin: '0 22px 22px' }}>
          <h3>لا توجد طلبات للمراجعة</h3>
          <p>استورد بيانات استمارة الراسبين من ملف CSV أو Excel لتظهر هنا للمراجعة والاعتماد.</p>
        </div>
      ) : (
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>الطالب</th>
                <th>ما اختاره في الاستمارة</th>
                <th>المواد المبلغ عن رسوبها</th>
                <th>الإجراء المعتمد</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((sub) => (
                <tr key={sub.id}>
                  <td>
                    <div className="table-person">
                      <div className="avatar small-avatar">{(sub.student_name_ar ?? '؟').slice(0, 1)}</div>
                      <span><b>{sub.student_name_ar ?? '—'}</b><small dir="ltr">{sub.national_id}</small></span>
                    </div>
                    {!sub.student_id && <small className="error-hint">غير مرتبط بحساب طالب</small>}
                  </td>
                  <td>
                    <span className={`status-pill ${sub.self_reported_case === 'parallel' ? 'approved' : 'pending'}`}>
                      {sub.self_reported_case === 'parallel' ? 'موازي (إعادة مع الأدنى)' : 'ترحيل (للترم الصيفي)'}
                    </span>
                  </td>
                  <td><small>{(sub.failed_subject_ids ?? []).map(subjectName).join(' · ') || '—'}</small></td>
                  <td>
                    <div className="row-actions">
                      <button className="approve-button" disabled={busyId === sub.id || !sub.student_id} onClick={() => void execute(sub, 'approved')}>
                        <Check size={15} /> اعتماد
                      </button>
                      <button className="reject-button" disabled={busyId === sub.id} onClick={() => void execute(sub, 'rejected')}>
                        <X size={15} /> رفض
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ padding: '0 22px 22px' }}>
        <div className="status-alert" style={{ margin: 0 }}>
          <div><b>صمام الأمان</b><p>كل قرار يحتاج ضغطة «اعتماد» منفصلة من الدكتور/المسؤول. لا يوجد تنفيذ جماعي للراسبين حمايةً للبيانات.</p></div>
        </div>
      </div>
    </section>
  );
}
