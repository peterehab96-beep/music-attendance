-- 016_widen_audio_frequency.sql
-- توسيع نطاق تردد الإشارة الصوتية إلى 15000–18000 هرتز:
-- سماعات الهواتف اللوحية وبعض الجوالات لا تنتج طاقة كافية عند 16.5–17.5 كيلوهرتز،
-- فنخفض الحد الأدنى قليلًا (ما زال فوق نطاق الصوت المسموع للكلام والموسيقى).

ALTER TABLE public.lecture_sessions
  DROP CONSTRAINT IF EXISTS lecture_sessions_audio_token_frequency_check;

ALTER TABLE public.lecture_sessions
  ADD CONSTRAINT lecture_sessions_audio_token_frequency_check
  CHECK (audio_token_frequency BETWEEN 15000 AND 18000);
