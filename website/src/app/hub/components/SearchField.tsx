'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { searchMaxChars } from '@/lib/community/search';
import styles from '../community.module.css';

export type SearchFieldProps = { value: string; onChange: (value: string) => void; onClear: () => void };

const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** `/` anywhere outside a field opens the search, as on most sites with one. */
function useSlashShortcut(onSlash: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      event.preventDefault(); onSlash();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onSlash]);
}

/**
 * The Hub's search: an icon that opens into a field in the bar, focused when the reader opens it (not
 * when a page arrives with `?q=`). Escape clears it, then closes it.
 */
export function SearchField({ value, onChange, onClear }: SearchFieldProps) {
  const [open, setOpen] = useState(!!value);
  const input = useRef<HTMLInputElement>(null);
  const reveal = useCallback(() => { setOpen(true); input.current?.focus(); }, []);
  useSlashShortcut(reveal);
  if (!open) return <button type="button" onClick={reveal} aria-label="Search harnesses"><Search /></button>;
  const escape = () => { if (value) onClear(); else setOpen(false); };
  return <form role="search" className={styles.searchField} onSubmit={event => event.preventDefault()}>
    <Search aria-hidden />
    <input ref={input} autoFocus={!value} type="search" aria-label="Search harnesses" placeholder="Search harnesses and creators" maxLength={searchMaxChars} value={value}
      onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') escape(); }} onBlur={() => { if (!value) setOpen(false); }} />
    {value && <button type="button" aria-label="Clear search" onMouseDown={event => event.preventDefault()} onClick={() => { onClear(); input.current?.focus(); }}><X /></button>}
  </form>;
}
