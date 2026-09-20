import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge has to be told about the P2 type scale.
 *
 * Without this, `cn` treats `text-t2` as a *text colour* rather than a font size,
 * because `t2` is not a size it recognises. Given `cn("text-t2", "text-state-live-ink")`
 * it sees two competing colours and keeps only the last one, silently deleting the
 * size. The component then renders at whatever size it inherits, which looks
 * plausible and is wrong - the class is in the source but not in the DOM.
 *
 * That is not hypothetical. It is what happened to StatusPill and the density
 * toggle: both passed `text-t2`/`text-t4` through `cn` next to a colour class, so
 * neither ever applied, and a component test asserting `text-state-live-ink`
 * would still have passed because colours were never the problem.
 *
 * Registering the four tier names here makes the tier utility resolve as a font
 * size, so it coexists with a colour the way `text-sm` already did.
 * `src/lib/design/merge.test.ts` pins this, including the case that used to fail.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["t1", "t2", "t3", "t4"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
