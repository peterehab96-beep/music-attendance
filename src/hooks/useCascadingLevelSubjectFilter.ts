import { useState, useEffect } from 'react';
import { database } from '../lib/insforge';
import { Subject } from '../lib/types';

export function useCascadingLevelSubjectFilter() {
  const [levels, setLevels] = useState<number[]>([1, 2, 3, 4]);
  const [selectedLevel, setSelectedLevel] = useState<number | null>(null);
  
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  
  const [isLoadingSubjects, setIsLoadingSubjects] = useState(false);

  useEffect(() => {
    if (!selectedLevel) {
      setSubjects([]);
      setSelectedSubjectId(null);
      return;
    }

    const fetchSubjects = async () => {
      setIsLoadingSubjects(true);
      const { data } = await database.from('subjects').select('*').eq('level', selectedLevel);
      setSubjects(data || []);
      setSelectedSubjectId(null);
      setIsLoadingSubjects(false);
    };

    fetchSubjects();
  }, [selectedLevel]);

  return {
    levels,
    selectedLevel,
    setSelectedLevel,
    subjects,
    selectedSubjectId,
    setSelectedSubjectId,
    isLoadingSubjects,
    isSelectionComplete: selectedLevel !== null && selectedSubjectId !== null
  };
}
