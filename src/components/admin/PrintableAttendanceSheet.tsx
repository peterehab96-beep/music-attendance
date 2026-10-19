import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SecretGrade } from '../../lib/types';

const STUDENTS_PER_SHEET = 30;

interface PrintableAttendanceSheetProps {
  students: SecretGrade[];
  level: number | '';
  semester: string;
  academicYear: string;
  subjectName: string;
}

export const PrintableAttendanceSheet: React.FC<PrintableAttendanceSheetProps> = (props) => {
  // SSR-safe: only render the portal in the browser. The sheet must live at
  // document.body level so the app shell's `display: none` print rule never
  // hides it — this was why the printout came out blank.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || typeof document === 'undefined') return null;

  return createPortal(<PrintableAttendanceSheetInner {...props} />, document.body);
};

const PrintableAttendanceSheetInner: React.FC<PrintableAttendanceSheetProps> = ({
  students,
  level,
  semester,
  academicYear,
  subjectName,
}) => {
  const getLevelArabic = (lvl: number | '') => {
    switch (lvl) {
      case 1:
        return 'الأول';
      case 2:
        return 'الثاني';
      case 3:
        return 'الثالث';
      case 4:
        return 'الرابع';
      default:
        return lvl ? String(lvl) : '..........';
    }
  };

  const getSemesterArabic = (sem: string) => {
    switch (sem) {
      case 'term1':
      case 'الأول':
      case 'First Semester':
      case 'الفصل الدراسي الأول':
        return 'الأول';
      case 'term2':
      case 'الثاني':
      case 'Second Semester':
      case 'الفصل الدراسي الثاني':
        return 'الثاني';
      case 'summer':
      case 'الصيفي':
      case 'Summer Semester':
      case 'الفصل الصيفي':
        return 'الصيفي';
      default:
        return sem || '..........';
    }
  };

  const getStudentStatusArabic = (student: SecretGrade) => {
    if (student.enrollment_status === 'parallel' || student.enrollment_status === 'deferred') {
      return 'منقول';
    }
    return 'مستجد';
  };

  const sheets: SecretGrade[][] = [];
  for (let i = 0; i < students.length; i += STUDENTS_PER_SHEET) {
    sheets.push(students.slice(i, i + STUDENTS_PER_SHEET));
  }
  if (sheets.length === 0) sheets.push([]);

  const SMALL_DOTS = '..........';

  return (
    <div className="printable-attendance-sheet" dir="rtl">
      {sheets.map((sheetStudents, sheetIndex) => (
        <section className="print-sheet" key={`sheet-${sheetIndex}`}>
          {/* Page Header */}
          <header className="print-header">
            <div className="print-header-right">
              <div className="print-logo-container">
                <img src="/logo.png" alt="جامعة الزقازيق" className="print-logo-img" />
              </div>
              <p className="print-faculty">كلية التربية النوعية</p>
              <p className="print-department">قسم : التربية الموسيقية</p>
              <p className="print-secret-number">الرقم السرى للكشف ( &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; )</p>
            </div>

            <div className="print-header-center">
              <h1 className="print-main-title">كشف درجات أعمال السنة / التطبيقي</h1>
              <p className="print-sub-info">
                المستوى <span>{getLevelArabic(level)}</span> / للفصل الدراسي <span>{getSemesterArabic(semester)}</span>
              </p>
              <p className="print-sub-info">
                العام الجامعي <span dir="ltr">{academicYear || '2025 / 2026'}</span>م
              </p>
              <p className="print-sub-info print-subject-line">
                المادة / <span>{subjectName || '................................'}</span>
              </p>
            </div>

            <div className="print-header-left">
              <div className="print-stats-box">
                <div className="print-box-title">رقم الكشف ( {sheetIndex + 1} )</div>
                <div className="print-box-row">حضور: .......</div>
                <div className="print-box-row">غياب: .......</div>
                <div className="print-box-row">إجمالى: .......</div>
              </div>
            </div>
          </header>

          {/* Main Print Table */}
          <table className="print-table">
            <thead>
              <tr>
                <th className="col-seat">رقم الجلوس</th>
                <th className="col-name">اسم الطالب</th>
                <th className="col-status">حالة الطالب</th>
                <th className="col-narrow">أعمال السنة</th>
                <th className="col-narrow">التطبيقي</th>
                <th className="col-notes">ملاحظات</th>
              </tr>
            </thead>
            <tbody>
              {sheetStudents.map((student, index) => (
                <tr key={student.student_id || index}>
                  <td className="col-seat text-center">{sheetIndex * STUDENTS_PER_SHEET + index + 1}</td>
                  <td className="col-name font-arabic-name">{student.student_name}</td>
                  <td className="col-status text-center">{getStudentStatusArabic(student)}</td>
                  <td className="col-narrow text-center font-bold">
                    {student.grade !== undefined && student.grade !== null ? student.grade : ''}
                  </td>
                  <td className="col-narrow text-center"></td>
                  <td className="col-notes"></td>
                </tr>
              ))}
              {sheetStudents.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center print-empty-row">
                    لا توجد بيانات طلاب مسجلة لهذه المادة
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Page Footer: اسم الممتحن أقصى اليمين، التوقيع في المنتصف تمامًا، رئيس القسم أقصى اليسار */}
          <footer className="print-footer">
            <div className="print-footer-section print-footer-right">
              <p className="footer-title">اسم الممتحن</p>
              <p className="dotted-line">{SMALL_DOTS}</p>
            </div>

            <div className="print-footer-section print-footer-center">
              <p className="footer-title">التوقيع</p>
              <p className="dotted-line">{SMALL_DOTS}</p>
            </div>

            <div className="print-footer-section print-footer-left">
              <p className="footer-title">رئيس القسم</p>
              <p className="dotted-line">{SMALL_DOTS}</p>
            </div>
          </footer>
        </section>
      ))}
    </div>
  );
};
