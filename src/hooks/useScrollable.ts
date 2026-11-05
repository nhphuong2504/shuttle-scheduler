import { useEffect, useState } from "react";

/**
 * Whether a region scrolls inside itself, measured from the region.
 *
 * A region that scrolls must be reachable from the keyboard, so the caller makes it focusable
 * only while this is true - the Desk's board does the same through its own `useScrollCue`. A
 * layout that scrolls only on some screens (Now's wall layout) then adds no tab stop elsewhere.
 * Re-measured when the region or its content changes size, when rows come and go, and on
 * window resize. It hands back a callback ref, so a region mounted late is still measured.
 */
export function useScrollable() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    if (!el) return;
    const measure = () => setScrollable(el.scrollHeight > el.clientHeight + 1);
    measure();
    window.addEventListener("resize", measure);
    const sizes = new ResizeObserver(measure);
    sizes.observe(el);
    if (el.firstElementChild) sizes.observe(el.firstElementChild);
    const rows = new MutationObserver(measure);
    rows.observe(el, { childList: true, subtree: true });
    return () => {
      window.removeEventListener("resize", measure);
      sizes.disconnect();
      rows.disconnect();
    };
  }, [el]);
  return [setEl, scrollable] as const;
}
