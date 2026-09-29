import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle, Users } from 'lucide-react';
import { getStudents } from '../../lib/api';
import { database } from '../../lib/insforge';
import { errorMessage } from '../../lib/api';
import type { Student } from '../../lib/types';
import { TERM_LABELS } from '../../lib/types';

export function BulkPromotionPanel({ notify }: { notify: (message: string, type?: 'success' | 'error' | 'info') => void }) {
  const [level, setLevel] = useState<number | ''>('');
  const [fromTerm, setFromTerm] = useState<string>('term1');
  const [academicYear, setAcademicYear] = useState<string>('');
  const [rows, setRows] = useState<Array<{ student: Student; subjects: string[] }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!level) { setRows([]); return; }
    setLoading(true);
    const [studentsRes, subjectsRes, enrollRes] = await Promise.all([
      getStudents(),
      database.from('subjects').select('id, name_ar').eq('level', level),
      database.from('student_subjects').select('student_id, subject_id').in('status', ['active', 'parallel']),
    ]);
    const subjectNames = new Map((subjectsRes.data ?? []).map((s: { id: string; name_ar: string }) => [s.id, s.name_ar]));
    const enrollmentByStudent = new Map<string, string[]>();
    for (const e of (enrollRes.data ?? []) as Array<{ student_id: string; subject_id: string }>) {
      const list = enrollmentByStudent.get(e.student_id) ?? [];
      const name = subjectNames.get(e.subject_id);
      if (name) list.push(name);
      enrollmentByStudent.set(e.student_id, list);
    }
    const filtered = (studentsRes.data ?? []).filter((s) => s.level === level && s.term === fromTerm);
    setRows(filtered.map((student) => ({ student, subjects: enrollmentByStudent.get(student.id) ?? [] })));
    setSelected(new Set());
    setLoading(false);
  }, [level, fromTerm]);

  useEffect(() => { void load(); }, [load]);

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(rows.map((r) => r.student.id)) : new Set());
  }

  async function promote() {
    if (!academicYear.trim()) return notify('أدخل السنة الدراسية أولًا.', 'error');
    if (selected.size === 0) return notify('اختر طلابًا للترقية.', 'error');
    setBusy(true);
    try {
      const { insforge } = await import('../../lib/insforge');
      const result = await insforge.functions.invoke('bulk-promote-passing-students', {
        body: { student_ids: [...selected], from_term: fromTerm, academic_year: academicYear.trim() },
      });
      if (result.error) notify(errorMessage(result.error, 'تعذر تنفيذ الترقية.'), 'error');
      else {
        notify(result.data?.message ?? `تمت ترقية ${selected.size} طالب`, 'success');
        void load();
      }
    } catch (error) { notify(errorMessage(error, 'تعذر تنفيذ الترقية.'), 'error'); }
    setBusy(false);
  }

  const allSelected = rows.length > 0 && selected.size === rows.length;

  return (
    <section className="table-card">
      <div className="table-card-head">
        <div><span className="eyebrow">الترقية بين الترمات</span><h3>ترقية الطلاب المنتظمين</h3></div>
        <span><Users size={16} /> {rows.length} طالب</span>
      </div>
      <div className="card-body">
        <div className="filter-bar">
          <select value={level} onChange={(e) => setLevel(Number(e.target.value) || '')} className="filter-select">
            <option value="">اختر الفرقة...</option>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>الفرقة {n}</option>)}
          </select>
          <select value={fromTerm} onChange={(e) => setFromTerm(e.target.value)} className="filter-select">
            <option value="term1">الترم الأول</option>
            <option value="term2">الترم الثاني</option>
            <option value="summer">الترم الصيفي</option>
          </select>
          <input
            value={academicYear}
            onChange={(e) => setAcademicYear(e.target.value)}
            placeholder="السنة الدراسية (مثال: 2025-2026)"
            dir="ltr"
            className="filter-input"
          />
        </div>

        <div className="status-alert">
          <div><b>تنبيه قبل الترقية</b><p>تأكد من أن هؤلاء الطلاب نجحوا في مواد القسم الأخرى قبل الترقية. النظام لا يتحقق من مواد خارج نطاق القسم.</p></div>
        </div>
      </div>

      {loading ? <div className="inline-loading"><span className="spinner" /> جارٍ التحميل…</div> : rows.length === 0 ? (
        <div className="empty-state" style={{ margin: '0 24px 24px' }}><h3>لا يوجد طلاب</h3><p>اختر فرقة وترم لعرض الطلاب المنتظمين.</p></div>
      ) : (
        <div className="responsive-table">
          <table>
            <thead><tr><th style={{ width: '48px' }}><input type="checkbox" checked={allSelected} onChange={(e) => toggleAll(e.target.checked)} className="row-checkbox" /></th><th>الطالب</th><th>المواد الحالية</th></tr></thead>
            <tbody>
              {rows.map(({ student, subjects }) => (
                <tr key={student.id}>
                  <td><input type="checkbox" checked={selected.has(student.id)} onChange={(e) => {
                    const next = new Set(selected);
                    e.target.checked ? next.add(student.id) : next.delete(student.id);
                    setSelected(next);
                  }} className="row-checkbox" /></td>
                  <td><div className="table-person"><div className="avatar small-avatar">{student.full_name_ar.slice(0, 1)}</div><span><b>{student.full_name_ar}</b><small dir="ltr">{student.national_id}</small></span></div></td>
                  <td><small>{subjects.join(' · ') || '—'}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="table-card-footer">
          <button className="primary-button" disabled={busy || selected.size === 0} onClick={() => void promote()}>
            {busy ? <><span className="button-spinner" /> جارٍ الترقية…</> : <><ArrowUpCircle size={17} /> ترقية {selected.size} طالب</>}
          </button>
        </div>
      )}
    </section>
  );
}
