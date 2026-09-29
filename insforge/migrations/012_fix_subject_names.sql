-- 012_fix_subject_names.sql
-- Fix subject names in the live database (the واو was missing):
--   قواعد صولفيج غربي 1 -> قواعد وصولفيج غربى 1
--   قواعد صولفيج غربي 2 -> قواعد وصولفيج غربى 2
--   قواعد صولفيج غربي 4 -> قواعد وصولفيج غربى 4
-- All other subject names must remain untouched.

UPDATE public.subjects SET name_ar = 'قواعد وصولفيج غربى 1' WHERE name_ar = 'قواعد صولفيج غربي 1';
UPDATE public.subjects SET name_ar = 'قواعد وصولفيج غربى 2' WHERE name_ar = 'قواعد صولفيج غربي 2';
UPDATE public.subjects SET name_ar = 'قواعد وصولفيج غربى 4' WHERE name_ar = 'قواعد صولفيج غربي 4';
