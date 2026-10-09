'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

type Edges = { left: boolean; right: boolean };

/**
 * A row that scrolls sideways under a mouse as well as a finger: which ends still hide something,
 * a page step either way, and centering one item. A vertical wheel over the row scrolls it, until
 * the row reaches its end; then the wheel scrolls the page again.
 */
export function useScrollRow<T extends HTMLElement>() {
  const row = useRef<T>(null);
  const [edges, setEdges] = useState<Edges>({ left: false, right: false });
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const update = () => {
      const left = element.scrollLeft > 1, right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setEdges(previous => previous.left === left && previous.right === right ? previous : { left, right });
    };
    const wheel = (event: WheelEvent) => {
      // A trackpad's sideways swipe already scrolls the row.
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const end = element.scrollWidth - element.clientWidth;
      if (end <= 0 || (event.deltaY < 0 && element.scrollLeft <= 0) || (event.deltaY > 0 && element.scrollLeft >= end)) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY;
    };
    // The observer also answers once at the start, so the ends are known without a render of their own.
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    resize?.observe(element);
    element.addEventListener('scroll', update, { passive: true });
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { resize?.disconnect(); element.removeEventListener('scroll', update); element.removeEventListener('wheel', wheel); };
  }, []);
  /** Scrolls most of a row's width one way, keeping a little of what was in view. */
  const step = useCallback((direction: 1 | -1) => {
    const element = row.current;
    element?.scrollBy?.({ left: direction * element.clientWidth * 0.7, behavior: 'smooth' });
  }, []);
  /** Brings an item to the row's middle, so its neighbours on both sides stay in view. */
  const center = useCallback((item: HTMLElement | null | undefined) => {
    const element = row.current;
    if (!element || !item) return;
    const box = element.getBoundingClientRect(), target = item.getBoundingClientRect();
    element.scrollBy?.({ left: target.left + target.width / 2 - (box.left + box.width / 2), behavior: 'smooth' });
  }, []);
  return { row, edges, step, center };
}
