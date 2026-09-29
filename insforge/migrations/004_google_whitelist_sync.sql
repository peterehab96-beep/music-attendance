-- Allow the trusted Google Sheets sync function to refresh unclaimed whitelist rows.
DROP FUNCTION IF EXISTS public.sync_national_ids_from_google(JSONB);
CREATE FUNCTION public.sync_national_ids_from_google(p_rows JSONB)
RETURNS TABLE (inserted_count INTEGER, updated_count INTEGER, skipped_claimed_count INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row JSONB;
  v_id TEXT;
  v_level SMALLINT;
  v_existing public.national_ids%ROWTYPE;
BEGIN
  inserted_count := 0;
  updated_count := 0;
  skipped_claimed_count := 0;

  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    v_id := regexp_replace(COALESCE(v_row->>'national_id', ''), '[^0-9]', '', 'g');
    v_level := NULLIF(v_row->>'level', '')::SMALLINT;
    IF v_id !~ '^[0-9]{14}$' OR NULLIF(trim(v_row->>'full_name_reference'), '') IS NULL OR v_level NOT BETWEEN 1 AND 4 THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_existing FROM public.national_ids WHERE national_id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.national_ids (national_id, full_name_reference, level, uploaded_by)
      VALUES (v_id, trim(v_row->>'full_name_reference'), v_level, NULL);
      inserted_count := inserted_count + 1;
    ELSIF v_existing.is_claimed THEN
      skipped_claimed_count := skipped_claimed_count + 1;
    ELSE
      UPDATE public.national_ids
      SET full_name_reference = trim(v_row->>'full_name_reference'),
          level = v_level,
          uploaded_by = NULL
      WHERE id = v_existing.id;
      updated_count := updated_count + 1;
    END IF;
  END LOOP;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_national_ids_from_google(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_national_ids_from_google(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.sync_national_ids_from_google(JSONB) FROM authenticated;
