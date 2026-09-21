import { type Page } from "@playwright/test";

/**
 * Waits for CSS animations inside an element to finish.
 *
 * This exists because Radix mounts dialog content with an entrance animation, and
 * `toBeVisible()` is satisfied the moment the element has non-zero size - which is
 * during the fade, at a few percent opacity. Scanning there is not a measurement of the
 * dialog; it is a measurement of the dialog blended with whatever is behind it, and axe
 * duly reports contrast failures that do not exist once the element is opaque. That was a
 * real false positive: the match-operations dialog measured 3.82-4.34:1 mid-animation and
 * no violations at all once settled.
 *
 * Infinite animations are skipped rather than awaited, because `finished` never resolves
 * for them and the helper would hang on any surface that pulses - and a pulsing indicator
 * is exactly what a live court board is.
 */
export async function settleAnimations(page: Page, selector: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate(async (el) => {
      const finite = el.getAnimations({ subtree: true }).filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return timing?.iterations !== Infinity;
      });
      await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
    });
}
