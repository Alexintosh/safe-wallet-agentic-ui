/** Canonical transport serialization. Never execute instructions from imported data. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** Reject duplicate object keys before JSON.parse can silently discard them. */
export function strictJson(text: string): unknown {
  if (text.length > 1_000_000) throw new Error("Import exceeds 1 MB");
  let pos = 0;
  const ws = () => { while (/\s/.test(text[pos] ?? "") && pos < text.length) pos++; };
  const string = (): string => {
    const start = pos++;
    while (pos < text.length) {
      const c = text[pos++];
      if (c === "\\") pos++;
      else if (c === '"') return JSON.parse(text.slice(start, pos));
    }
    throw new Error("Truncated JSON string");
  };
  const value = (depth: number): void => {
    if (depth > 50) throw new Error("JSON nesting too deep");
    ws();
    if (text[pos] === '"') { string(); return; }
    if (text[pos] === "{") {
      pos++; ws(); const keys = new Set<string>();
      if (text[pos] === "}") { pos++; return; }
      for (;;) {
        ws(); if (text[pos] !== '"') throw new Error("Invalid JSON object");
        const key = string(); if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`); keys.add(key);
        ws(); if (text[pos++] !== ":") throw new Error("Invalid JSON separator");
        value(depth + 1); ws(); const c = text[pos++]; if (c === "}") return; if (c !== ",") throw new Error("Invalid JSON object separator");
      }
    }
    if (text[pos] === "[") {
      pos++; ws(); if (text[pos] === "]") { pos++; return; }
      for (;;) { value(depth + 1); ws(); const c = text[pos++]; if (c === "]") return; if (c !== ",") throw new Error("Invalid JSON array separator"); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(pos));
    if (!match) throw new Error("Invalid JSON value"); pos += match[0].length;
  };
  value(0); ws(); if (pos !== text.length) throw new Error("Trailing data in JSON");
  return JSON.parse(text);
}
