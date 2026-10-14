import { object } from "../config.ts";

/** Display JSON/JSONL string fields as multiline text, without altering stored tool data. */
export function readableStructuredText(text: string): string {
  const render = (value: unknown, depth = 0): string => {
    if (typeof value === "string") return value;
    if (depth >= 8) return JSON.stringify(value, null, 2);
    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item] as const)
      : object(value)
        ? Object.entries(value)
        : undefined;
    if (!entries?.length) return JSON.stringify(value);
    return entries
      .map(([key, item]) => {
        const rendered = render(item, depth + 1);
        return rendered.includes("\n")
          ? `${key}:\n${rendered
              .split("\n")
              .map((line) => `  ${line}`)
              .join("\n")}`
          : `${key}: ${rendered}`;
      })
      .join("\n");
  };
  const parse = (source: string): string | undefined => {
    if (!/^[\s]*[\[{]/.test(source)) return undefined;
    try {
      return render(JSON.parse(source));
    } catch {
      return undefined;
    }
  };
  // Whole JSON first, then JSONL mixed with plain status lines. Never blindly replace escapes.
  return (
    parse(text) ??
    text
      .split("\n")
      .map((line) => parse(line) ?? line)
      .join("\n")
  );
}
