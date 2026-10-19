'use client';
import { useEffect, type KeyboardEvent, type RefObject } from 'react';

const items = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

/**
 * A menu button's keyboard: opening moves focus to the first item, the arrows (and Home and End) move
 * between items, and Escape or Tab closes it — Escape back to its button.
 */
export function useMenuKeys(menu: RefObject<HTMLElement | null>, button: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => { if (open) items(menu.current)[0]?.focus(); }, [menu, open]);
  return (event: KeyboardEvent) => {
    const all = items(menu.current), at = all.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => { event.preventDefault(); all[(index + all.length) % all.length]?.focus(); };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(all.length - 1);
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); button.current?.focus(); }
    else if (event.key === 'Tab') onClose();
  };
}
