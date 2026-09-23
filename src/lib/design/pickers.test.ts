import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Native pickers are presented by the page, not by the engine.
 *
 * `input[type=date]` and `input[type=time]` each draw their own glyph in the field's right
 * edge. It is painted by the browser, so it takes no `--color-*` token, no size the design
 * system can set, and no focus ring - and on a dark surface the only lever the theme has
 * over it is `color-scheme`. `PickerInput` removes it and draws an icon from the set
 * instead, as a real button: the glyph it replaces was already a separate click target, so
 * a decorative swap would have quietly removed the only way into the popup.
 *
 * These guards fail loudly if a field goes back to the raw element, or if the rule that
 * removes the glyph is dropped and a field ends up drawing two icons in its right edge.
 */

const root = join(__dirname, "../../..");

const read = (relative: string) => readFileSync(join(root, relative), "utf8");

/** Every shipped `.tsx` under `src`, so a new route cannot opt out by not being listed. */
function sources(dir = join(root, "src")): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    if (!full.endsWith(".tsx")) return [];
    /**
     * Test files are excluded deliberately. A test is not a surface that draws anything, and
     * it is where a generic name and a raw field are exercised on purpose - the component
     * test has to mount `<PickerInput type="date">` with no `pickerLabel` to pin the default.
     * Keeping them in would have made the guard assert against its own fixtures.
     */
    return /\.(test|spec)\.tsx$/.test(full) ? [] : [full];
  });
}

/**
 * Source with comments removed, because comments are prose.
 *
 * The `[^:]` guard leaves `https://` alone. This is not a parser and does not need to be:
 * getting it wrong can only hide a field from the guard, never invent one, and the fields
 * it is looking for are written as markup.
 */
const markupOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("no field is left drawing the engine's own picker glyph", () => {
  const files = sources();

  it("covers the tree it claims to", () => {
    // A walk that matched nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.endsWith("picker-input.tsx"))).toBe(true);
    // The exclusions are the interesting half: a walk that quietly returned nothing would
    // satisfy the count above only if the filter were the other way round.
    expect(files.some((file) => /\.(test|spec)\.tsx$/.test(file))).toBe(false);
  });

  it("routes every date and time field through PickerInput", () => {
    const offenders: string[] = [];

    for (const file of files) {
      // Split into tags: a `type` attribute only matters on the tag that carries it, and
      // searching the whole file would flag a file for having both anywhere in it. The
      // lowercase element is caught too - it draws the same engine glyph, so leaving it out
      // would make the guard a way round the rule rather than a way to enforce it.
      for (const tag of markupOnly(readFileSync(file, "utf8")).split("<").slice(1)) {
        if (!/^(Input|input)[\s/>]/.test(tag)) continue;
        const type = /type="(date|time)"/.exec(tag);
        if (type) {
          const name = tag.startsWith("Input") ? "Input" : "input";
          offenders.push(`${file.slice(root.length + 1)}: <${name} type="${type[1]}">`);
        }
      }
    }

    expect(offenders, "a raw date or time input draws the browser's own glyph").toEqual([]);
  });

  it("removes that glyph in one place, and only where it is replaced", () => {
    const css = read("src/styles.css");
    expect(css).toMatch(
      /\.picker-field::-webkit-calendar-picker-indicator\s*\{\s*display:\s*none;?\s*\}/,
    );
    // Scoped to the class rather than to every `input[type=date]`: a field that wants the
    // native control should not lose it by existing.
    expect(css).not.toMatch(/input\[type=["']?(date|time)["']?\]::-webkit-calendar-picker-indicator/);
    expect(read("src/components/ui/picker-input.tsx")).toMatch(/picker-field/);
  });

  it("gives the replacement a real control, with a name to announce", () => {
    const component = read("src/components/ui/picker-input.tsx");
    // A decorative span would look identical and be unreachable by keyboard.
    expect(component).toMatch(/<Button/);
    expect(component).toMatch(/aria-label=/);
    // The name has to be able to name the field it opens: a day list holds three per day,
    // and an identical name repeated down the page names none of them.
    expect(component).toMatch(/pickerLabel/);
    // `showPicker()` throws on a disabled field and is absent in older engines, so the
    // fallback has to exist or the button becomes a dead end rather than an unreachable one.
    expect(component).toMatch(/showPicker/);
    expect(component).toMatch(/input\.focus\(\)/);
  });

  it("names each picker for the field it opens", () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const tag of markupOnly(readFileSync(file, "utf8")).split("<").slice(1)) {
        if (!/^PickerInput[\s/>]/.test(tag)) continue;
        if (!/pickerLabel=/.test(tag)) {
          offenders.push(`${file.slice(root.length + 1)}: <PickerInput> without pickerLabel`);
        }
      }
    }

    expect(offenders, "a picker button announces only a generic name").toEqual([]);
  });
});
