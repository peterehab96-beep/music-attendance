export type RepeaterRow = {
  national_id: string;
  student_name?: string;
  self_reported_case: 'parallel' | 'deferred';
  failed_subjects: string;
};

export type RepeaterParseResult = RepeaterRow[];

// تحويل أسطر الاستمارة (CSV/XLSX) لصفوف منطقة العزل.
// الأعمدة المتوقعة (أي ترتيب، نطابق بالاسم العربي أو الإنجليزي):
//   رقم الهوية / الاسم الكامل / الترم القادم / حالة الرسوب / المواد
const HEADER_ALIASES: Record<string, string> = {
  'رقم الهوية': 'national_id', 'رقم الهويه': 'national_id', 'الهوية': 'national_id', 'national_id': 'national_id',
  'الاسم الكامل': 'student_name', 'الاسم': 'student_name', 'اسم الطالب': 'student_name', 'student_name': 'student_name',
  'الترم القادم': 'term', 'الترم': 'term', 'term': 'term',
  'حالة الرسوب': 'case', 'الحالة': 'case', 'case': 'case',
  'المواد التي رسبت فيها': 'subjects', 'المواد': 'subjects', 'subjects': 'subjects',
};

function normalize(value: unknown): string {
  return String(value ?? '').trim();
}

function pickCase(raw: string): 'parallel' | 'deferred' {
  // أي عبارة تحتوي "مادة" (مثل "راسب في مادة أو مادتين") → موازي
  if (/مادة|مادت|مواز/i.test(raw)) return 'parallel';
  return 'deferred';
}

async function fromMatrix(matrix: unknown[][]): Promise<RepeaterParseResult> {
  if (matrix.length < 2) return [];
  const header = matrix[0].map(normalize);
  const indexes: Record<string, number> = {};
  header.forEach((name, i) => {
    const key = HEADER_ALIASES[name] ?? HEADER_ALIASES[name.replace(/\s+/g, ' ')];
    if (key) indexes[key] = i;
  });

  const rows: RepeaterParseResult = [];
  for (let r = 1; r < matrix.length; r += 1) {
    const cell = (key: string) => indexes[key] !== undefined ? normalize(matrix[r][indexes[key]]) : '';
    const nationalId = cell('national_id').replace(/\D/g, '');
    if (!nationalId) continue;
    rows.push({
      national_id: nationalId,
      student_name: cell('student_name') || undefined,
      self_reported_case: pickCase(cell('case')),
      failed_subjects: cell('subjects'),
    });
  }
  return rows;
}

export async function parseRepeaterFile(file: File): Promise<RepeaterParseResult> {
  const name = file.name.toLowerCase();
  const text = await file.text();
  const matrix = text.split(/\r?\n/).map((line) => line.split(/[,،\t]/).map((c) => c.trim().replace(/^["']|["']$/g, '')));
  return fromMatrix(matrix);
}
