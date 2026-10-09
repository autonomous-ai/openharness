'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { communityRequest, starterSnapshot } from '@/lib/community/client';
import type { OpenHarness, SourceFile } from '@/lib/community/types';

/**
 * A harness's source files, read the first time the reader asks for them (`wanted`): a starter's
 * from this site, a publication's from the Hub. The page itself carries only the output.
 */
export function useHarnessFiles(id: string, wanted: boolean) {
  const [files, setFiles] = useState<SourceFile[] | null>(null), [error, setError] = useState('');
  const started = useRef(false);
  const load = useCallback(async () => {
    setError('');
    try {
      const harness = id.startsWith('starter-') ? await starterSnapshot(id) : (await communityRequest<{ harness: OpenHarness | null }>(`harnesses/${id}`)).harness;
      if (!harness) throw new Error('Harness unavailable.');
      setFiles(harness.files);
    } catch { setError('The source files could not be loaded.'); }
  }, [id]);
  useEffect(() => {
    if (!wanted || started.current) return;
    started.current = true; void load();
  }, [wanted, load]);
  return { files, error, load };
}
