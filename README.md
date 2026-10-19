# حضور — نظام حضور ودرجات قسم التربية الموسيقية

منصة ويب لتسجيل حضور الطلاب ومتابعة درجات أعمال السنة في قسم التربية الموسيقية — كلية التربية النوعية، جامعة الزقازيق.

## المميزات

- **تسجيل حضور بالبصمة + الموقع الجغرافي** (WebAuthn Passkeys + Geofencing) داخل نطاق الكلية
- **تسجيل حضور بالإشارة الصوتية** (Above-audio-range beacon 15–18kHz) لبضاعة الأجهزة التي لا يدعمها GPS
- **دعم كامل للأجهزة اللوحية** (iPadOS/Android tablets) والأرقام العمانية والقومية المصرية
- **سجل الدرجات السري** — تُحسب درجات أعمال السنة من نسبة الحضور، والطلاب لا يرونها
- **قانون الحضور المادة ٣٥** — إنذاران ثم خصم وحرمان آلي وفق لائحة الكلية، مع خصوصية كاملة للخصم
- **كشف درجات رسمي قابل للطباعة** (A4، 30 طالبًا/كشف) بصيغة الكلية
- **مزامنة قائمة الأرقام المسموح لها** من Google Sheets (Apps Script أو Edge Function)
- **تصدير الدرجات** إلى Google Sheets و Excel

## البنية التقنية

| الطبقة | التقنية |
|---|---|
| الواجهة | React 18 + TypeScript + Vite |
| التصميم | CSS يدوي (RTL عربي كامل) + lucide-react |
| الباكند | InsForge (Postgres + PostgREST + Deno Edge Functions) |
| المصادقة | InsForge Auth + WebAuthn Passkeys |
| قاعدة البيانات | 19 migrations versioned في `insforge/migrations/` |

## هيكل المشروع

```
├── src/                    # واجهة React
│   ├── App.tsx             # التطبيق الرئيسي (لوحة الطالب + لوحة الأدمن)
│   ├── components/         # مكوّنات الطالب والأدمن
│   └── lib/                # عميل SDK، دوال API، تحقق الأرقام، الأجهزة
├── functions/              # Deno Edge Functions (check-in, audio-check-in, ...)
├── insforge/migrations/    # SQL migrations بالترتيب (001 → 019)
├── scripts/                # نشر قاعدة البيانات وزرع الأدمن
├── google-apps-script/     # مزامنة الشيت تلقائيًا كل 15 دقيقة
└── public/                 # الشعار والأصول الثابتة
```

## التشغيل محليًا

```bash
npm install
npm run dev          # واجهة التطوير
npm run build        # بناء الإنتاج
npm run db:deploy    # تطبيق migrations على قاعدة البيانات
```

أنشئ `.env.local` فيه:

```
VITE_INSFORGE_URL=https://<project>.us-east.insforge.app
VITE_INSFORGE_ANON_KEY=<anon-key>
```

## النشر

- **الواجهة:** `npm run build` ثم `npx @insforge/cli deployments deploy`
- **الدوال:** `npx @insforge/cli functions deploy <name> --file functions/<file>.ts`
- **قاعدة البيانات:** `node scripts/deploy-database.mjs`

## الأداء واختبار الحمل

- `node scripts/load-test.mjs` — يقيس قدرة الكتابة في قاعدة البيانات (آمن، يستخدم جدولًا مؤقتًا يُحذف).
- `node scripts/load-test.mjs --api --confirm --students=200 [--retries=2]` — يقيس تزامن تسجيلات الحضور عبر HTTP، ينشئ مستخدمين مؤقتين وينظّفهم تلقائيًا.
- تدفق تسجيل الحضور موحّد في استدعاءين RPC (`check_in_prepare` + `check_in_commit`) بدل ~10 استعلامات، مع إعادة محاولة أسّية في العميل.

## الأمان

- RLS مفعل على كل الجداول — الطالب لا يرى درجاته السرية إطلاقًا
- كل العمليات الحساسة تتحقق من صلاحية الأدمن على مستوى قاعدة البيانات
- توكنز Google مشفرة AES-GCM في قاعدة البيانات
- مفاتيح الأسرار في متغيرات بيئة المنصة (لا توجد أسرار في الكود)

---

© 2026 Dr. Peter Ehab Atef Ezzat. All rights reserved.
