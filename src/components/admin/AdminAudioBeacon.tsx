import { useEffect, useRef, useState } from 'react';
import { Radio, Square, UserCheck } from 'lucide-react';
import { database } from '../../lib/insforge';
import { errorMessage } from '../../lib/api';

type Props = { sessionId: string; subjectId: string; active: boolean; beaconActive: boolean; frequency?: number | null; notify: (message: string, type?: 'success' | 'error' | 'info') => void; onChanged: () => void };

export function AdminAudioBeacon({ sessionId, subjectId, active, beaconActive, frequency, notify, onChanged }: Props) {
  const contextRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const repeatTimerRef = useRef<number | null>(null);
  const [isEmitting, setIsEmitting] = useState(beaconActive);
  const [manualNationalId, setManualNationalId] = useState('');
  const [currentFrequency, setCurrentFrequency] = useState<number | null>(frequency ?? null);

  function startOscillator(context: AudioContext, freq: number) {
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = freq;
    oscillator.connect(context.destination);
    oscillator.start();
    oscillatorRef.current = oscillator;
    setIsEmitting(true);
    setCurrentFrequency(freq);
  }

  // نشغّل النغمة دفعات متكررة (ثانيتان صوت ثم ثانية صمت) بدل نغمة مستمرة:
  // الميكروفونات التي تطبق كبت الضوضاء تُضعف النغمة المستمرة كثيرًا، والدفعات
  // المتقطعة تلتقطها أجهزة الطلاب أسرع وأوضح.
  function startRepeating(context: AudioContext, freq: number) {
    startOscillator(context, freq);
    if (repeatTimerRef.current) window.clearInterval(repeatTimerRef.current);
    repeatTimerRef.current = window.setInterval(() => {
      const oscillator = oscillatorRef.current;
      if (!oscillator || !contextRef.current) return;
      try {
        oscillator.stop();
        oscillator.disconnect();
      } catch { /* already stopped */ }
      oscillatorRef.current = null;
      window.setTimeout(() => {
        if (contextRef.current && !oscillatorRef.current) {
          try { startOscillator(contextRef.current, freq); } catch { /* context closed */ }
        }
      }, 900);
    }, 3000);
  }

  async function stopBeacon(silent = false) {
    if (repeatTimerRef.current) { window.clearInterval(repeatTimerRef.current); repeatTimerRef.current = null; }
    try { oscillatorRef.current?.stop(); } catch { /* already stopped */ }
    oscillatorRef.current?.disconnect(); oscillatorRef.current = null;
    await contextRef.current?.close().catch(() => undefined); contextRef.current = null;
    setIsEmitting(false);
    const result = await database.from('lecture_sessions').update({ is_attendance_active: false }).eq('id', sessionId);
    if (result.error && !silent) notify(errorMessage(result.error, 'تعذر إيقاف الإشارة الصوتية.'), 'error');
    if (!silent && !result.error) { notify('تم إيقاف الإشارة الصوتية.', 'info'); onChanged(); }
  }

  async function startBeacon() {
    if (isEmitting) return;
    if (typeof window === 'undefined' || !window.AudioContext) return notify('هذا المتصفح لا يدعم الإشارة الصوتية.', 'error');
    // Resume the stored tone when the beacon is already live in the database
    // (e.g. the page was reloaded mid-session); otherwise pick a fresh one.
    const freq = frequency ?? Math.floor(Math.random() * 2001) + 15500;
    const result = await database.from('lecture_sessions').update({ is_attendance_active: true, audio_token_frequency: freq }).eq('id', sessionId);
    if (result.error) return notify(errorMessage(result.error, 'تعذر تشغيل الإشارة الصوتية.'), 'error');
    try {
      const context = new AudioContext();
      if (context.state === 'suspended') await context.resume();
      contextRef.current = context;
      startRepeating(context, freq);
      notify('تم تشغيل الإشارة الصوتية للمحاضرة.', 'success'); onChanged();
    } catch (error) { await stopBeacon(true); notify(errorMessage(error, 'تعذر تشغيل صوت الإشارة.'), 'error'); }
  }

  async function recordManual() {
    const nationalId = manualNationalId.replace(/\D/g, '');
    if (!/^(\d{6,9}|\d{14})$/.test(nationalId)) return notify('أدخل رقمًا صحيحًا: 14 رقمًا (قومي مصري) أو 6–9 أرقام (مدني عماني).', 'error');
    const { data: student, error: studentError } = await database.from('students').select('id').eq('national_id', nationalId).maybeSingle();
    if (studentError || !student) return notify('الرقم غير مسجل أو غير مرتبط بحساب طالب.', 'error');
    const { data: enrollment } = await database.from('student_subjects').select('student_id').eq('student_id', student.id).eq('subject_id', subjectId).in('status', ['active', 'parallel']).maybeSingle();
    if (!enrollment) return notify('هذا الطالب غير مسجل في مادة المحاضرة الحالية.', 'error');
    const { error } = await database.from('attendance_logs').insert({ session_id: sessionId, student_id: student.id, check_in_method: 'manual_admin' });
    if (error) return notify(errorMessage(error, 'تعذر تسجيل الحضور اليدوي.'), 'error');
    setManualNationalId(''); notify('تم تسجيل الحضور يدويًا.', 'success');
  }

  // Resume the stored tone on mount if the beacon is already live, so the UI and
  // the database never disagree about whether the signal is playing.
  useEffect(() => {
    if (!beaconActive || !frequency || typeof window === 'undefined' || !window.AudioContext) return;
    if (oscillatorRef.current) return; // already playing
    const context = new AudioContext();
    if (context.state === 'suspended') void context.resume();
    contextRef.current = context;
    startRepeating(context, frequency);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beaconActive, frequency, sessionId]);

  useEffect(() => () => { void stopBeacon(true); }, []);

  if (!active) return null;
  return (
    <section className="table-card">
      <div className="table-card-head">
        <div><span className="eyebrow">تحقق إضافي</span><h3>الإشارة الصوتية</h3></div>
      </div>
      <div style={{ padding: '20px 24px' }}>
        <p style={{ color: 'var(--muted)', fontSize: '13px', marginBottom: '8px' }}>
          شغّل الإشارة من جهاز المحاضر وارفع الصوت لأقصى درجة، ثم يلتقطها الطلاب من داخل القاعة عبر ميكروفون هواتفهم.
        </p>
        <p style={{ color: 'var(--muted)', fontSize: '13px', marginBottom: '16px' }}>
          النغمة فوق نطاق السمع للكلام وتعمل على دفعات (ثانيتان صوت ثم صمت) لتصل لكل الأجهزة، حتى الأجهزة اللوحية.
        </p>
        <div className="page-actions" style={{ marginBottom: '20px' }}>
          {isEmitting ? (
            <button className="danger-button" onClick={() => void stopBeacon()} style={{ minHeight: '44px', padding: '0 18px' }}>
              <Square size={16} /> إيقاف الإشارة الصوتية
            </button>
          ) : (
            <button className="primary-button" onClick={() => void startBeacon()} style={{ minHeight: '44px', padding: '0 18px' }}>
              <Radio size={16} /> بدء الإشارة الصوتية
            </button>
          )}
          {isEmitting && currentFrequency !== null && (
            <span style={{ color: 'var(--muted)', fontSize: '13px', alignSelf: 'center' }}>
              تردد هذه المحاضرة: <b dir="ltr">{currentFrequency}</b> هرتز
            </span>
          )}
        </div>
        <div className="two-fields" style={{ alignItems: 'flex-end' }}>
          <label>
            تسجيل يدوي للضرورة
            <input value={manualNationalId} onChange={(event) => setManualNationalId(event.target.value.replace(/\D/g, '').slice(0, 14))} inputMode="numeric" placeholder="قومي مصري (14) أو مدني عماني (6–9)" dir="ltr" />
          </label>
          <button className="secondary-button" onClick={() => void recordManual()} style={{ minHeight: '48px', padding: '0 18px' }}>
            <UserCheck size={16} /> تسجيل يدوي
          </button>
        </div>
      </div>
    </section>
  );
}
