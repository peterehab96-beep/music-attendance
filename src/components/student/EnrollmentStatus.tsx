import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, RotateCw } from 'lucide-react';
import { getStudentEnrollments, type EnrollmentRow } from '../../lib/api';

const STATUS_META: Record<string, { label: string; icon: React.ReactNode; tone: string }> = {
  active: { label: 'نشط', icon: <CheckCircle2 size={16} />, tone: 'status-active' },
  parallel: { label: 'إعادة موازية', icon: <RotateCw size={15} />, tone: 'status-parallel' },
  deferred: { label: 'مُرحَّل', icon: <Clock3 size={15} />, tone: 'status-deferred' },
};

export function EnrollmentStatus({ studentId }: { studentId: string }) {
  const [rows, setRows] = useState<EnrollmentRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getStudentEnrollments(studentId).then((result) => {
      setRows(result.data);
      setLoading(false);
    });
  }, [studentId]);

  if (loading) return null;
  if (!rows.length) return null;

  const name = (row: EnrollmentRow) => {
    const s = Array.isArray(row.subjects) ? row.subjects[0] : row.subjects;
    return s?.name_ar ?? 'مادة دراسية';
  };

  return (
    <section className="table-card">
      <div className="table-card-head">
        <div>
          <span className="eyebrow">السجل الأكاديمي</span>
          <h3>حالة التسجيل الحالية</h3>
        </div>
        <span>{rows.length} مواد مسجلة</span>
      </div>
      <div className="subject-list">
        {rows.map((row) => {
          const meta = STATUS_META[row.status] ?? STATUS_META.active;
          return (
            <div className="subject-row" key={`${row.subject_id}-${row.status}`}>
              <div className={`enrollment-icon-badge ${meta.tone}`}>
                {meta.icon}
              </div>
              <div style={{ flex: 1 }}>
                <b>{name(row)}</b>
                <small className={meta.tone}>{meta.label}</small>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
