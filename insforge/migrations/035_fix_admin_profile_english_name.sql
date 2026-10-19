-- ══════════════════════════════════════════════════════════════════════
-- 035_fix_admin_profile_english_name.sql
-- عيب كشفه الاختبار الحي: حفظ الاسم الإنجليزي «Dr. Shaimaa Hijazi» كان
-- يُرفض لأن قيد الحروف كان لا يسمح بالنقطة في اللقب (Dr.). نسمح بالنقطة
-- والمسافات — الحروف فقط تبقى إنجليزية.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_update_own_profile(
  p_full_name_ar TEXT,
  p_full_name_en TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ar TEXT := btrim(regexp_replace(COALESCE(p_full_name_ar, ''), '\s+', ' ', 'g'));
  v_en TEXT := btrim(regexp_replace(COALESCE(p_full_name_en, ''), '\s+', ' ', 'g'));
BEGIN
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'غير مصرح — هذه العملية للأدمن فقط');
  END IF;
  IF v_ar = '' OR v_en = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'الاسم بالعربية والإنجليزية مطلوبان معًا');
  END IF;
  IF v_ar ~ '[A-Za-z0-9]' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'الاسم بالعربية يجب أن يكون بحروف عربية فقط');
  END IF;
  IF v_en !~ '^[A-Za-z][A-Za-z .]*$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'الاسم بالإنجليزية يجب أن يكون بحروف إنجليزية فقط');
  END IF;
  IF array_length(regexp_split_to_array(v_ar, '\s+'), 1) < 2
     OR array_length(regexp_split_to_array(v_en, '\s+'), 1) < 2 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', 'أدخل الاسم كاملًا بالعربية والإنجليزية');
  END IF;

  UPDATE public.admins
     SET full_name = v_ar, full_name_ar = v_ar, full_name_en = v_en
   WHERE id = auth.uid();

  INSERT INTO public.audit_logs (action, entity_type, entity_id, actor_id, metadata)
  VALUES ('admin_update_own_profile', 'admins', auth.uid(), auth.uid(),
    jsonb_build_object('full_name_ar', v_ar, 'full_name_en', v_en));

  RETURN jsonb_build_object('ok', TRUE, 'full_name_ar', v_ar, 'full_name_en', v_en, 'full_name', v_ar);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_update_own_profile(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_update_own_profile(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_update_own_profile(TEXT, TEXT) TO authenticated;
