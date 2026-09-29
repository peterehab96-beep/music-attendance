const INSFORGE_SYNC_ENDPOINT = 'https://xjh5wnbh.function2.insforge.app/sync-whitelist-google';
const SPREADSHEET_ID = '1vH1qNW_XwzMGU0gio9dbEBPzdLwYBAKi04wSytjhTwM';
const DATA_SHEET_NAME = 'البيانات'; // إن لم توجد يُستخدم أول شيت (ردود النموذج)

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('مزامنة النظام')
    .addItem('مزامنة قائمة الأرقام الآن', 'syncWhitelistToSystem')
    .addItem('تثبيت المزامنة التلقائية', 'installWhitelistSyncTrigger')
    .addToUi();
}

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[إأآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[\s_-]/g, '');
}

function normalizeDigits(value) {
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
  return String(value || '')
    .replace(/[٠-٩]/g, function (digit) { return String(arabicDigits.indexOf(digit)); })
    .replace(/\D/g, '');
}

function bytesToHex(bytes) {
  return bytes.map(function (byte) {
    const value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function buildRowsFromSheet() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(DATA_SHEET_NAME) || spreadsheet.getSheets()[0];
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) throw new Error('الشيت لا يحتوي على بيانات كافية.');

  const headers = values[0].map(normalizeHeader);
  const idIndex = headers.findIndex(function (header) { return header.indexOf('الرقمالقومي') !== -1 || header.indexOf('nationalid') !== -1; });
  const civilIdIndex = headers.findIndex(function (header) { return header.indexOf('الرقمالمدني') !== -1 || header.indexOf('civilid') !== -1; });
  const nameIndex = headers.findIndex(function (header) { return header.indexOf('الاسم') !== -1 || header.indexOf('name') !== -1; });
  const levelIndex = headers.findIndex(function (header) { return header.indexOf('المستوي') !== -1 || header.indexOf('level') !== -1; });
  if ((idIndex < 0 && civilIdIndex < 0) || nameIndex < 0 || levelIndex < 0) throw new Error('يلزم وجود أعمدة: الرقم القومي (مصري) أو الرقم المدني (عماني)، الاسم، المستوى.');

  const seen = {};
  const rows = [];
  values.slice(1).forEach(function (row) {
    // المصري: من عمود الرقم القومي، والعماني: من عمود الرقم المدني عندما يكون الأول فارغًا
    const nationalId = (idIndex >= 0 ? normalizeDigits(row[idIndex]) : '') || (civilIdIndex >= 0 ? normalizeDigits(row[civilIdIndex]) : '');
    const fullName = String(row[nameIndex] || '').trim();
    const level = normalizeDigits(row[levelIndex]);
    if (!/^(\d{6,9}|\d{14})$/.test(nationalId) || !fullName || !/^[1-4]$/.test(level) || seen[nationalId]) return;
    seen[nationalId] = true;
    rows.push({ national_id: nationalId, full_name_reference: fullName, level: Number(level) });
  });
  return rows;
}

function syncWhitelistToSystem() {
  const secret = PropertiesService.getScriptProperties().getProperty('INSFORGE_SYNC_SECRET');
  if (!secret) throw new Error('لم يتم ضبط INSFORGE_SYNC_SECRET في Script Properties.');

  const payload = JSON.stringify({ rows: buildRowsFromSheet(), synced_at: new Date().toISOString() });
  const signature = bytesToHex(Utilities.computeHmacSha256Signature(payload, secret));
  const response = UrlFetchApp.fetch(INSFORGE_SYNC_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    payload: payload,
    muteHttpExceptions: true,
    headers: { 'X-Google-Sync-Signature': signature },
  });

  const status = response.getResponseCode();
  const text = response.getContentText();
  if (status < 200 || status >= 300) throw new Error('فشلت المزامنة: ' + text);

  const result = JSON.parse(text);
  SpreadsheetApp.openById(SPREADSHEET_ID).toast(
    'تمت المزامنة: جديد ' + result.inserted_count + '، تحديث ' + result.updated_count + '، مستخدم مسبقًا ' + result.skipped_claimed_count,
    'مزامنة النظام',
    8
  );
  return result;
}

function installWhitelistSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'syncWhitelistToSystem') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('syncWhitelistToSystem').timeBased().everyMinutes(15).create();
  SpreadsheetApp.openById(SPREADSHEET_ID).toast('تم تثبيت المزامنة التلقائية كل 15 دقيقة.', 'مزامنة النظام', 8);
}
