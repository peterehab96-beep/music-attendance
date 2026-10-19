-- ══════════════════════════════════════════════════════════════════════
-- 034_fix_sessions_admin_read_scope.sql
-- عيب حقيقي كشفه الاختبار الحي بعد 033: سياسة قراءة الجلسات كانت تحتوي
--    EXISTS (SELECT 1 FROM public.subject_admins sa
--             WHERE sa.admin_id = auth.uid() AND sa.subject_id = subject_id)
-- والاسم `subject_id` غير مُقيَّد يُحَل إلى عمود `sa.subject_id` نفسه (أقرب
-- نطاق يملك الاسم) → الشرط يصبح صحيحًا دائمًا لأي إدمن يملك مادة واحدة على
-- الأقل، فيقرأ جلسات كل المواد. الحل: تأهيل العمود باسم الجدول نفسه.
-- (تحقّق: أدمن مادة «صولفيج غربي 5» رأى 5 جلسات من أصل 5 — بعد الإصلاح
--  يرى 3 فقط وهي جلسات مادته.)
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS sessions_student_read_admin_all ON public.lecture_sessions;
CREATE POLICY sessions_student_read_admin_all ON public.lecture_sessions
  FOR SELECT USING (
    public.is_super_admin()
    OR (public.is_admin() AND EXISTS (
      SELECT 1 FROM public.subject_admins sa
       WHERE sa.admin_id = auth.uid()
         AND sa.subject_id = public.lecture_sessions.subject_id))
    OR (is_active AND EXISTS (SELECT 1 FROM public.students st WHERE st.id = auth.uid() AND st.status = 'approved'))
  );

-- نفس الاحتياط لسياسة إدراج الحضور (المقصود عمود attendance_logs.session_id).
DROP POLICY IF EXISTS admin_insert_attendance ON public.attendance_logs;
CREATE POLICY admin_insert_attendance ON public.attendance_logs
  FOR INSERT WITH CHECK (
    public.is_super_admin()
    OR (public.is_admin() AND EXISTS (
      SELECT 1 FROM public.lecture_sessions ls
       WHERE ls.id = public.attendance_logs.session_id
         AND public.is_subject_admin_for(auth.uid(), ls.subject_id)))
  );
