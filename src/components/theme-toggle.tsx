import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { applyTheme, readTheme, writeTheme, type ThemeChoice } from "@/lib/theme";

const OPTIONS: { value: ThemeChoice; label: string; title: string }[] = [
  { value: "auto", label: "Auto", title: "Follow the device setting" },
  { value: "bright", label: "Bright", title: "Daylight hall" },
  { value: "dim", label: "Dim", title: "Low-light hall" },
];

/**
 * Three-way lighting switch.
 *
 * Mounted empty on the server and filled in after hydration: the stored choice
 * lives in `localStorage`, so rendering it during SSR would guarantee a mismatch.
 * The palette itself is already correct at first paint — the boot script in the
 * document head sets it — so only this control waits.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice | null>(null);

  useEffect(() => {
    const stored = readTheme();
    setChoice(stored);
    applyTheme(stored);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(readTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border border-hairline bg-muted/50 p-0.5",
        className,
      )}
      role="group"
      aria-label="Venue lighting"
    >
      {OPTIONS.map((option) => {
        const active = choice === option.value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-pressed={active}
            onClick={() => {
              setChoice(option.value);
              writeTheme(option.value);
            }}
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors",
              active
                ? "bg-surface text-foreground shadow-panel"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
