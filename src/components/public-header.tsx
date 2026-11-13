import { useEffect, useState, type ReactNode } from "react";
import "./public-header.css";
import "./header-interactions.css";

/** A steady public navigation bar; depth indicates content is passing beneath it. */
export function PublicHeader({ children }: { children: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      setScrolled(window.scrollY > 8);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header className="public-header" data-scrolled={scrolled}>
      {children}
    </header>
  );
}
