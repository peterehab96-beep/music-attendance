import * as XLSX from 'xlsx';

export type WhitelistRecord = {
  national_id: string;
  full_name_reference: string;
  level: number | null;
};

export type WhitelistParseResult = {
  records: WhitelistRecord[];
  totalRows: number;
  rejectedRows: number;
  duplicateRows: number;
};

const arabicDigits = '٠١٢٣٤٥٦٧٨٩';

// الرقم القومي المصري (14 رقمًا) أو الرقم المدني العماني (من 6 إلى 9 أرقام)
export const VALID_ID_PATTERN = /^(\d{6,9}|\d{14})$/

function normalizeDigits(value: unknown) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/\D/g, '');
}

function normalizedHeader(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[إأآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[\s_-]/g, '');
}

function parseCsv(text: string): unknown[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && text[index + 1] === '"' && quoted) { cell += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (character === ',' && !quoted) { row.push(cell); cell = ''; continue; }
    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = []; cell = '';
      continue;
    }
    cell += character;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export async function parseWhitelistFile(file: File): Promise<WhitelistParseResult> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  let rows: unknown[][];
  if (extension === 'csv') {
    rows = parseCsv(await file.text());
  } else if (extension === 'xlsx') {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as unknown[][];
  } else {
    throw new Error('الصيغة غير مدعومة. استخدم CSV أو XLSX.');
  }

  if (!rows.length || !Array.isArray(rows[0])) throw new Error('الملف فارغ أو لا يحتوي على صف عناوين.');
  const headers = rows[0].map(normalizedHeader);
  const idIndex = headers.findIndex((header) => header.includes('nationalid') || header.includes('الرقمالقومي'));
  const civilIdIndex = headers.findIndex((header) => header.includes('الرقمالمدني') || header.includes('civilid'));
  const nameIndex = headers.findIndex((header) => header.includes('name') || header.includes('الاسم'));
  const levelIndex = headers.findIndex((header) => header.includes('level') || header.includes('المستوي'));
  if (idIndex < 0 && civilIdIndex < 0) throw new Error('لم نجد عمود الرقم القومي (مصري) أو الرقم المدني (عماني).');
  if (nameIndex < 0 || levelIndex < 0) throw new Error('يلزم وجود الأعمدة: الرقم/الهوية، الاسم، المستوى.');

  const seen = new Set<string>();
  const records: WhitelistRecord[] = [];
  let rejectedRows = 0;
  let duplicateRows = 0;
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row) || !row.some((cell) => String(cell ?? '').trim())) continue;
    // المصري: من عمود الرقم القومي، والعماني: من عمود الرقم المدني عندما يكون الأول فارغًا
    const national_id = (idIndex >= 0 ? normalizeDigits(row[idIndex]) : '') || (civilIdIndex >= 0 ? normalizeDigits(row[civilIdIndex]) : '');
    const full_name_reference = String(row[nameIndex] ?? '').trim();
    const levelText = normalizeDigits(row[levelIndex]);
    const level = levelText ? Number(levelText) : null;
    if (!VALID_ID_PATTERN.test(national_id) || !full_name_reference || level === null || ![1, 2, 3, 4].includes(level)) { rejectedRows += 1; continue; }
    if (seen.has(national_id)) { duplicateRows += 1; continue; }
    seen.add(national_id);
    records.push({ national_id, full_name_reference, level });
  }
  return { records, totalRows: rows.length - 1, rejectedRows, duplicateRows };
}
