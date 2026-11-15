// Motion helpers for the landing page: smooth scrolling (Lenis), reveal-on-scroll, a "decode" text scramble and
// count-up numbers. All of them respect prefers-reduced-motion: the final state is shown at once.

import Lenis from 'lenis';
import { createElement, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export const reducedMotion = (): boolean => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let lenisRef: Lenis | null = null;
/** Smooth scrolling for the page that calls it; stops when the page unmounts. */
export function useLenis(): void {
  useEffect(() => {
    if (reducedMotion()) return;
    const lenis = new Lenis({ lerp: 0.09, smoothWheel: true, wheelMultiplier: 0.9 });
    lenisRef = lenis;
    let id = 0;
    const raf = (t: number): void => {
      lenis.raf(t);
      id = requestAnimationFrame(raf);
    };
    id = requestAnimationFrame(raf);
    return () => {
      cancelAnimationFrame(id);
      lenis.destroy();
      lenisRef = null;
    };
  }, []);
}

export function scrollToId(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (lenisRef) lenisRef.scrollTo(el, { offset: -40, duration: 1.4 });
  else el.scrollIntoView({ behavior: 'smooth' });
}

/** Scroll progress of the page in pixels, throttled to animation frames. */
export function useScrollY(): number {
  const [y, setY] = useState(0);
  useEffect(() => {
    let raf = 0;
    const on = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setY(window.scrollY));
    };
    window.addEventListener('scroll', on, { passive: true });
    return () => {
      window.removeEventListener('scroll', on);
      cancelAnimationFrame(raf);
    };
  }, []);
  return y;
}

/** True once the element has entered the viewport (it stays true). */
export function useInView<T extends Element>(margin = '0px 0px -12% 0px'): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, margin]);
  return [ref, seen];
}

/** Fades and lifts its children into place when scrolled into view. `delay` in ms. */
export function Reveal({ children, delay = 0, as = 'div', className = '', style }: { children: ReactNode; delay?: number; as?: 'div' | 'span' | 'section' | 'li' | 'p'; className?: string; style?: CSSProperties }) {
  const [ref, seen] = useInView<HTMLElement>();
  return createElement(as, { ref, className: `rv ${seen ? 'in' : ''} ${className}`, style: { ...style, transitionDelay: `${delay}ms` } }, children);
}

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&/<>=+*';

/** The "decode" effect: characters flicker through random glyphs and settle left to right. */
export function Scramble({ text, delay = 0, duration = 900, className = '', start }: { text: string; delay?: number; duration?: number; className?: string; start?: boolean }) {
  const [ref, seen] = useInView<HTMLSpanElement>();
  const go = start ?? seen;
  const [out, setOut] = useState(() => (reducedMotion() ? text : text.replace(/\S/g, ' ')));
  useEffect(() => {
    if (!go) return;
    if (reducedMotion()) {
      setOut(text);
      return;
    }
    let raf = 0;
    const t0 = performance.now() + delay;
    const tick = (): void => {
      const now = performance.now();
      const p = Math.max(0, Math.min(1, (now - t0) / duration));
      const settled = Math.floor(p * text.length);
      let s = '';
      for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (c === ' ' || i < settled) s += c;
        else if (now < t0 + (i / text.length) * duration * 0.35) s += ' ';
        else s += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      setOut(s);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [go, text, delay, duration]);
  return (
    <span ref={ref} className={`scr ${className}`} aria-label={text}>
      <span aria-hidden>{out}</span>
    </span>
  );
}

/** Counts up to `value` when scrolled into view. */
export function CountUp({ value, decimals = 0, prefix = '', suffix = '', duration = 1400 }: { value: number; decimals?: number; prefix?: string; suffix?: string; duration?: number }) {
  const [ref, seen] = useInView<HTMLSpanElement>();
  const [v, setV] = useState(reducedMotion() ? value : 0);
  useEffect(() => {
    if (!seen || reducedMotion()) {
      if (seen) setV(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (): void => {
      const now = performance.now();
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 4);
      setV(value * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, value, duration]);
  return (
    <span ref={ref}>
      {prefix}
      {v.toFixed(decimals)}
      {suffix}
    </span>
  );
}
