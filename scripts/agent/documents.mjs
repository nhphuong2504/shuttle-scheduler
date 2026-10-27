import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
    .replace(/\s/g, "-");

export function headings(text) {
  const counts = new Map(),
    result = [];
  let fenced = false;
  for (const [index, line] of text.split("\n").entries()) {
    if (/^\s*```|^\s*~~~/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (!match) continue;
    const base = slug(match[2]),
      count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    result.push({ anchor: base + (count ? `-${count}` : ""), index, depth: match[1].length });
  }
  return result;
}

export function section(text, anchor) {
  if (!anchor) return text;
  const rows = headings(text),
    start = rows.findIndex((row) => row.anchor === anchor);
  if (start < 0) throw new Error(`Unknown document section: #${anchor}`);
  const end = rows.slice(start + 1).find((row) => row.depth <= rows[start].depth);
  return text.split("\n").slice(rows[start].index, end?.index).join("\n");
}

export function validateReferences(root, references) {
  const errors = [];
  for (const reference of new Set(references)) {
    const [file, anchor] = reference.split("#");
    const target = path.resolve(root, file);
    if (path.relative(root, target).startsWith("..") || !existsSync(target)) {
      errors.push(`Missing/outside repository: ${reference}`);
      continue;
    }
    if (anchor && !headings(readFileSync(target, "utf8")).some((row) => row.anchor === anchor)) {
      const text = readFileSync(target, "utf8");
      if (!text.includes(`id="${anchor}"`)) errors.push(`Missing anchor: ${reference}`);
    }
  }
  return errors;
}

export function localLinks(root, file) {
  const text = readFileSync(path.join(root, file), "utf8").replace(
    /^```[^\n]*\n[\s\S]*?^```\s*$/gm,
    "",
  );
  return [...text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].flatMap((match) => {
    const url = match[1];
    if (/^[a-z][\w+.-]*:/i.test(url) || url.startsWith("/")) return [];
    const [target, anchor] = url.split("#");
    return [
      path.relative(
        root,
        path.resolve(root, path.dirname(file), decodeURIComponent(target || path.basename(file))),
      ) + (anchor ? `#${anchor}` : ""),
    ];
  });
}
