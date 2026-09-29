export function isMobileDevice() {
  if (typeof navigator === 'undefined') return false;
  const isMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  // iPadOS 13+ يعرّف نفسه في المتصفح كـ "Macintosh" لكنه يبقى جهازًا لمسيًا،
  // لذلك نعتمد اللمس (maxTouchPoints) لا وصف المتصفح فقط — هذا يتيح جميع
  // الأجهزة اللوحية (أندرويد وiPad) دون فتح الباب لأجهزة سطح المكتب.
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isTabletUA = /iPad|Tablet|PlayBook|Silk/i.test(navigator.userAgent);
  return (isMobileUA || isTabletUA || (hasTouch && navigator.maxTouchPoints >= 5)) && hasTouch;
}

export function supportsPasskeys() {
  return typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function';
}

export async function readCurrentLocation(): Promise<{ latitude: number; longitude: number }> {
  if (!navigator.geolocation) throw new Error('المتصفح لا يدعم تحديد الموقع الجغرافي.');
  return new Promise((resolve, reject) => {
    let settled = false;
    // نجرب الدقة العالية أولًا؛ إن فشل (أجهزة قديمة/داخل مبنى) نعيد المحاولة
    // بدقة الشبكة مع السماح بآخر موقع معروف — كثير من الأجهزة القديمة لا
    // تستجيب إلا لهذا الوضع.
    const tryGet = (highAccuracy: boolean, maxAge: number) => {
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => { settled = true; resolve({ latitude: coords.latitude, longitude: coords.longitude }); },
        (error) => {
          if (settled) return;
          if (highAccuracy) {
            tryGet(false, 120000);
          } else {
            const detail = error.code === error.PERMISSION_DENIED
              ? 'اسمح للمتصفح بالوصول إلى موقعك من إعدادات الهاتف.'
              : 'تأكد من تفعيل خدمة الموقع (GPS) من إعدادات الهاتف وتعيينها على "دقة عالية".';
            reject(new Error(`تعذر قراءة موقعك. ${detail} أو استخدم تسجيل الحضور بالصوت من داخل القاعة.`));
          }
        },
        { enableHighAccuracy: highAccuracy, timeout: highAccuracy ? 15000 : 20000, maximumAge: maxAge },
      );
    };
    tryGet(true, 0);
  });
}
