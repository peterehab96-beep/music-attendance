import { useState } from 'react';
import { Radio } from 'lucide-react';
import { insforge } from '../../lib/insforge';
import { errorMessage } from '../../lib/api';

// ملاحظة فنية مهمة: يجب إنشاء AudioContext بقيود إلغاء الصدى وكبت الضوضاء
// معطّلة "قبل" طلب الميكروفون. المعالجة الافتراضية للميكروفون (DSP) في الأندرويد
// وiOS تُخرِّج الترددات فوق السمعية (15–18 كيلوهرتز) فتختفي الإشارة تمامًا —
// وهذا كان سبب فشل ميزة الموجات الصوتية نهائيًا على الهواتف.
export function StudentAudioReceiver({ sessionId, notify, onSuccess }: { sessionId: string; notify: (message: string, type?: 'success' | 'error' | 'info') => void; onSuccess: () => void }) {
  const [busy, setBusy] = useState(false);

  async function detect() {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return notify('هذا المتصفح لا يدعم التقاط الصوت. جرّب Chrome أو Safari الحديث.', 'error');
    }
    setBusy(true);
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    try {
      // 1) أنشئ السياق الصوتي أولًا بقيود خام بدون معالجة DSP (تقبلها متصفحات
      // كروم/سفاري الحديثة ضمن AudioContextOptions؛ والقديمة تتجاهلها بأمان).
      const Ctx: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) throw new Error('هذا المتصفح لا يدعم تحليل الصوت.');
      context = new Ctx({ echoCancellation: false, noiseSuppression: false, autoGainControl: false } as AudioContextOptions);
      if (context.state === 'suspended') await context.resume();

      // 2) اطلب الميكروفون بذات القيود لمنع المتصفح من معالجة الإشارة.
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch {
        // بعض الأجهزة القديمة ترفض القيود؛ جرّب الطلب الافتراضي.
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 16384;
      source.connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const binWidth = context.sampleRate / analyser.fftSize;
      // نطاق الفحص أوسع قليلًا من نطاق البث (15–18 كيلوهرتز) لتسامح العتاد.
      const startBin = Math.max(0, Math.floor(14900 / binWidth));
      const endBin = Math.min(bins.length - 1, Math.ceil(18100 / binWidth));

      // نمشي على عينات FFT كل 120 مللي ثانية لمدة تصل إلى 8 ثوانٍ (تغطي دورة
      // دفعات الإشارة: ثانيتان صوت ثم صمت)، ونحتفظ بأقوى قمة رصدناها.
      let peak = 0;
      let peakIndex = 0;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        analyser.getByteFrequencyData(bins);
        for (let index = startBin; index <= endBin; index += 1) {
          if (bins[index] > peak) { peak = bins[index]; peakIndex = index; }
        }
        if (peak >= 20) break;
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }

      if (peak < 15) {
        const detectedHz = Math.round((peakIndex * context.sampleRate) / analyser.fftSize);
        throw new Error(
          `لم نلتقط الإشارة بوضوح (أقوى مستوى ${peak}%${peakIndex > 0 && detectedHz > 14000 && detectedHz < 19000 ? ` عند ${detectedHz} هرتز` : ''}). ` +
          'ارفع صوت جهاز المحاضر لأقصى درجة، واقترب منه، وأغلق النوافذ الصاخبة ثم أعد المحاولة.'
        );
      }

      // تحويل فهرس الشريحة إلى تردد فعلي بالهرتز.
      const frequency = (peakIndex * context.sampleRate) / analyser.fftSize;
      const result = await insforge.functions.invoke<{ message: string }>('audio-check-in', { body: { session_id: sessionId, detected_frequency: frequency } });
      if (result.error) throw new Error(errorMessage(result.error, 'تعذر التحقق من الإشارة الصوتية.'));
      notify(result.data?.message ?? 'تم تسجيل حضورك بالإشارة الصوتية.', 'success');
      onSuccess();
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      notify(
        name === 'NotAllowedError'
          ? 'يلزم السماح باستخدام الميكروفون لتسجيل الحضور بالصوت. اضغط "سماح" عند ظهور الطلب.'
          : errorMessage(error, 'تعذر التقاط الإشارة الصوتية.'),
        'error',
      );
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      await context?.close().catch(() => undefined);
      setBusy(false);
    }
  }

  return (
    <button
      className="secondary-button full"
      disabled={busy}
      onClick={() => void detect()}
      style={{
        marginTop: '8px',
        minHeight: '46px',
        borderColor: busy ? 'var(--mint)' : undefined,
        color: busy ? 'var(--green)' : undefined,
        background: busy ? 'var(--mint-light)' : undefined,
      }}
    >
      {busy ? (
        <>
          <span className="button-spinner" />
          <span>جارٍ الاستماع للإشارة في القاعة… (حتى 8 ثوانٍ)</span>
        </>
      ) : (
        <>
          <Radio size={17} style={{ color: 'var(--clay)' }} />
          <span>تسجيل الحضور بالصوت</span>
        </>
      )}
    </button>
  );
}
