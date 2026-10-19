-- ══════════════════════════════════════════════════════════════════════
-- 036_security_audit_panel.sql
-- لوحة «سجل العمليات» للمشرف العام:
--   1) جدول login_events: كل محاولة دخول (ناجحة أو فاشلة) مع الوقت الدقيق
--      وIP والجهاز والنظام واللغة والمنطقة الزمنية وإحداثيات GPS إن سُمح بها.
--   2) دوال قراءة مقيدة بالمشرف العام فقط (is_super_admin):
--        admin_audit_logs      — سجل التدقيق مع بحث وفلاتر وترقيم صفحات
--        admin_login_events    — سجل الدخول والأجهزة
--        admin_audit_facets    — قوائم الفلاتر (الأفعال/الكيانات/الأشخاص)
--        admin_security_summary — أرقام سريعة لآخر ٢٤ ساعة و٧ أيام
--   3) تشديد قراءة audit_logs: كانت متاحة لكل أدمن (حتى أدمن المادة)،
--      واللوحة الآن للمشرف العام فقط، فنفس القيد يُطبَّق على الجدول نفسه.
-- ملاحظة أمنية: لا تُخزَّن كلمات المرور ولا رموز الجلسات إطلاقًا؛ فقط
-- بيانات التعريف والجهاز والشبكة والموقع الذي يسمح به المتصفح.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) جدول أحداث الدخول ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.login_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  identity TEXT,                                   -- البريد أو المعرّف الذي حاول الدخول
  role TEXT NOT NULL DEFAULT 'unknown',             -- admin | student | unknown
  status TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed')),
  method TEXT NOT NULL DEFAULT 'password',          -- password | register | passkey | google
  failure_reason TEXT,
  ip TEXT,
  forwarded_for TEXT,
  user_agent TEXT,
  platform TEXT,
  language TEXT,
  timezone TEXT,
  screen TEXT,
  latitude NUMERIC(9, 6),
  longitude NUMERIC(9, 6),
  accuracy_m NUMERIC(10, 2),
  geo_source TEXT,                                  -- gps | ip | null
  city TEXT,
  region TEXT,
  country TEXT,
  country_code TEXT,
  org TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.login_events IS 'سجل كل محاولة دخول للنظام — للمشرف العام فقط عبر الدوال الآمنة.';
COMMENT ON COLUMN public.login_events.geo_source IS 'gps = إحداثيات من المتصفح، ip = تقدير من عنوان الشبكة، null = غير متاح.';

CREATE INDEX IF NOT EXISTS idx_login_events_created ON public.login_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON public.login_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_status ON public.login_events(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_ip ON public.login_events(ip, created_at DESC);

ALTER TABLE public.login_events ENABLE ROW LEVEL SECURITY;
-- لا سياسات: لا قراءة ولا كتابة من المتصفح. القراءة عبر الدوال أدناه،
-- والكتابة عبر وظيفة log-login بمفتاح الخدمة فقط.
REVOKE ALL ON public.login_events FROM anon, authenticated;

-- ── 2) فهارس مساعدة لسجل التدقيق ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs(entity_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs(actor_id, created_at DESC);

-- ── 3) تشديد قراءة سجل التدقيق إلى المشرف العام ──────────────────────
DROP POLICY IF EXISTS audit_admin_only ON public.audit_logs;
DROP POLICY IF EXISTS audit_super_admin_only ON public.audit_logs;
CREATE POLICY audit_super_admin_only ON public.audit_logs
  FOR SELECT USING (public.is_super_admin(auth.uid()));

-- ── 4) سجل التدقيق: بحث + فلاتر + ترقيم ──────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_audit_logs(
  p_search TEXT DEFAULT NULL,
  p_action TEXT DEFAULT NULL,
  p_entity_type TEXT DEFAULT NULL,
  p_actor_id UUID DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  action TEXT,
  entity_type TEXT,
  entity_id UUID,
  actor_id UUID,
  actor_name TEXT,
  actor_email TEXT,
  actor_kind TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  total_count BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_search TEXT := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'غير مصرح — سجل العمليات للمشرف العام فقط';
  END IF;

  RETURN QUERY
  WITH joined AS (
    SELECT a.id, a.action, a.entity_type, a.entity_id, a.actor_id, a.metadata, a.created_at,
           COALESCE(ad.full_name_ar, ad.full_name, st.full_name_ar) AS actor_name,
           COALESCE(ad.email, st.email) AS actor_email,
           CASE WHEN ad.id IS NOT NULL THEN 'admin'
                WHEN st.id IS NOT NULL THEN 'student'
                ELSE 'system' END AS actor_kind
    FROM public.audit_logs a
    LEFT JOIN public.admins ad ON ad.id = a.actor_id
    LEFT JOIN public.students st ON st.id = a.actor_id
  ), filtered AS (
    SELECT * FROM joined j
    WHERE (p_action IS NULL OR p_action = '' OR j.action = p_action)
      AND (p_entity_type IS NULL OR p_entity_type = '' OR j.entity_type = p_entity_type)
      AND (p_actor_id IS NULL OR j.actor_id = p_actor_id)
      AND (p_from IS NULL OR j.created_at >= p_from)
      AND (p_to IS NULL OR j.created_at <= p_to)
      AND (v_search IS NULL
           OR j.action ILIKE '%' || v_search || '%'
           OR j.entity_type ILIKE '%' || v_search || '%'
           OR COALESCE(j.actor_name, '') ILIKE '%' || v_search || '%'
           OR COALESCE(j.actor_email, '') ILIKE '%' || v_search || '%'
           OR COALESCE(j.entity_id::TEXT, '') ILIKE '%' || v_search || '%'
           OR j.metadata::TEXT ILIKE '%' || v_search || '%')
  ), counted AS (SELECT COUNT(*) AS total FROM filtered)
  SELECT f.id, f.action, f.entity_type, f.entity_id, f.actor_id,
         f.actor_name, f.actor_email, f.actor_kind, f.metadata, f.created_at, c.total
  FROM filtered f CROSS JOIN counted c
  ORDER BY f.created_at DESC, f.id DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_audit_logs(TEXT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_audit_logs(TEXT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER) TO authenticated;

-- ── 5) سجل الدخول والأجهزة ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_login_events(
  p_search TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_role TEXT DEFAULT NULL,
  p_method TEXT DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_limit INTEGER DEFAULT 50,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  identity TEXT,
  role TEXT,
  status TEXT,
  method TEXT,
  failure_reason TEXT,
  ip TEXT,
  forwarded_for TEXT,
  user_agent TEXT,
  platform TEXT,
  language TEXT,
  timezone TEXT,
  screen TEXT,
  latitude NUMERIC,
  longitude NUMERIC,
  accuracy_m NUMERIC,
  geo_source TEXT,
  city TEXT,
  region TEXT,
  country TEXT,
  country_code TEXT,
  org TEXT,
  display_name TEXT,
  email TEXT,
  created_at TIMESTAMPTZ,
  total_count BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset INTEGER := GREATEST(COALESCE(p_offset, 0), 0);
  v_search TEXT := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'غير مصرح — سجل الدخول للمشرف العام فقط';
  END IF;

  RETURN QUERY
  WITH joined AS (
    SELECT e.*,
           COALESCE(ad.full_name_ar, ad.full_name, st.full_name_ar) AS display_name,
           COALESCE(ad.email, st.email) AS email
    FROM public.login_events e
    LEFT JOIN public.admins ad ON ad.id = e.user_id
    LEFT JOIN public.students st ON st.id = e.user_id
  ), filtered AS (
    SELECT * FROM joined j
    WHERE (p_status IS NULL OR p_status = '' OR j.status = p_status)
      AND (p_role IS NULL OR p_role = '' OR j.role = p_role)
      AND (p_method IS NULL OR p_method = '' OR j.method = p_method)
      AND (p_user_id IS NULL OR j.user_id = p_user_id)
      AND (p_from IS NULL OR j.created_at >= p_from)
      AND (p_to IS NULL OR j.created_at <= p_to)
      AND (v_search IS NULL
           OR COALESCE(j.identity, '') ILIKE '%' || v_search || '%'
           OR COALESCE(j.display_name, '') ILIKE '%' || v_search || '%'
           OR COALESCE(j.email, '') ILIKE '%' || v_search || '%'
           OR COALESCE(j.ip, '') ILIKE '%' || v_search || '%'
           OR COALESCE(j.city, '') ILIKE '%' || v_search || '%'
           OR COALESCE(j.country, '') ILIKE '%' || v_search || '%'
           OR COALESCE(j.user_agent, '') ILIKE '%' || v_search || '%'
           OR COALESCE(j.failure_reason, '') ILIKE '%' || v_search || '%')
  ), counted AS (SELECT COUNT(*) AS total FROM filtered)
  SELECT f.id, f.user_id, f.identity, f.role, f.status, f.method, f.failure_reason,
         f.ip, f.forwarded_for, f.user_agent, f.platform, f.language, f.timezone, f.screen,
         f.latitude, f.longitude, f.accuracy_m, f.geo_source,
         f.city, f.region, f.country, f.country_code, f.org,
         f.display_name, f.email, f.created_at, c.total
  FROM filtered f CROSS JOIN counted c
  ORDER BY f.created_at DESC, f.id DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_login_events(TEXT, TEXT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_login_events(TEXT, TEXT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER) TO authenticated;

-- ── 6) قوائم الفلاتر ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_audit_facets()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_result JSONB;
BEGIN
  IF NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'غير مصرح — سجل العمليات للمشرف العام فقط';
  END IF;

  SELECT jsonb_build_object(
    'actions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('value', s.action, 'count', s.n) ORDER BY s.n DESC)
      FROM (SELECT action, COUNT(*)::INTEGER AS n FROM public.audit_logs GROUP BY 1) s
    ), '[]'::jsonb),
    'entities', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('value', s.entity_type, 'count', s.n) ORDER BY s.n DESC)
      FROM (SELECT entity_type, COUNT(*)::INTEGER AS n FROM public.audit_logs GROUP BY 1) s
    ), '[]'::jsonb),
    'actors', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.actor_id, 'name', s.name, 'kind', s.kind, 'count', s.n) ORDER BY s.n DESC)
      FROM (
        SELECT a.actor_id,
               COALESCE(ad.full_name_ar, ad.full_name, st.full_name_ar, 'النظام') AS name,
               CASE WHEN ad.id IS NOT NULL THEN 'admin' WHEN st.id IS NOT NULL THEN 'student' ELSE 'system' END AS kind,
               COUNT(*)::INTEGER AS n
        FROM public.audit_logs a
        LEFT JOIN public.admins ad ON ad.id = a.actor_id
        LEFT JOIN public.students st ON st.id = a.actor_id
        WHERE a.actor_id IS NOT NULL
        GROUP BY a.actor_id, ad.id, ad.full_name_ar, ad.full_name, st.id, st.full_name_ar
        -- قائمة انتقائية: كل الأدمنة + الطلاب الذين تكررت عملياتهم فقط.
        -- بقية الأشخاص يُعثر عليهم بالبحث النصي في السجل.
        HAVING ad.id IS NOT NULL OR COUNT(*) >= 3
      ) s
      LIMIT 50
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_audit_facets() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_audit_facets() TO authenticated;

-- ── 7) ملخص أمني سريع ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_security_summary()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_result JSONB;
BEGIN
  IF NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'غير مصرح — سجل العمليات للمشرف العام فقط';
  END IF;

  SELECT jsonb_build_object(
    'logins_24h',          (SELECT COUNT(*)::INTEGER FROM public.login_events WHERE status = 'success' AND created_at >= NOW() - INTERVAL '24 hours'),
    'failed_24h',          (SELECT COUNT(*)::INTEGER FROM public.login_events WHERE status = 'failed'  AND created_at >= NOW() - INTERVAL '24 hours'),
    'ips_24h',             (SELECT COUNT(DISTINCT ip)::INTEGER FROM public.login_events WHERE created_at >= NOW() - INTERVAL '24 hours' AND ip IS NOT NULL),
    'devices_24h',         (SELECT COUNT(DISTINCT user_agent)::INTEGER FROM public.login_events WHERE created_at >= NOW() - INTERVAL '24 hours' AND user_agent IS NOT NULL),
    'gps_24h',             (SELECT COUNT(*)::INTEGER FROM public.login_events WHERE created_at >= NOW() - INTERVAL '24 hours' AND geo_source = 'gps'),
    'admins_24h',          (SELECT COUNT(DISTINCT user_id)::INTEGER FROM public.login_events WHERE status = 'success' AND role = 'admin' AND created_at >= NOW() - INTERVAL '24 hours'),
    'students_24h',        (SELECT COUNT(DISTINCT user_id)::INTEGER FROM public.login_events WHERE status = 'success' AND role = 'student' AND created_at >= NOW() - INTERVAL '24 hours'),
    'actions_24h',         (SELECT COUNT(*)::INTEGER FROM public.audit_logs WHERE created_at >= NOW() - INTERVAL '24 hours'),
    'actions_7d',          (SELECT COUNT(*)::INTEGER FROM public.audit_logs WHERE created_at >= NOW() - INTERVAL '7 days'),
    'total_logins',        (SELECT COUNT(*)::INTEGER FROM public.login_events WHERE status = 'success'),
    'total_failed',        (SELECT COUNT(*)::INTEGER FROM public.login_events WHERE status = 'failed'),
    'last_login_at',       (SELECT MAX(created_at) FROM public.login_events WHERE status = 'success'),
    'last_failed_at',      (SELECT MAX(created_at) FROM public.login_events WHERE status = 'failed')
  ) INTO v_result;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_security_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_security_summary() TO authenticated;
