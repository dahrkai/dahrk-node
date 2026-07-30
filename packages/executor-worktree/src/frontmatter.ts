/**
 * A minimal YAML-frontmatter reader/writer for the overlay's command reshape.
 *
 * Deliberately small and dependency-free: the overlay only reshapes flat, single-line command
 * frontmatter (`description`, `argument-hint`), so a full YAML parser is not warranted. The delimiter
 * handling mirrors Pi's own frontmatter parser (`---` ... `\n---`, body trimmed) so a template written
 * here is read back identically by Pi's prompt-template loader.
 */

export type Frontmatter = Record<string, string | undefined>;

/** Split leading `---` frontmatter from the body, returning flat top-level `key: value` pairs. */
export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const normalised = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalised.startsWith("---")) return { frontmatter: {}, body: normalised };
  const endIndex = normalised.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter: {}, body: normalised };

  const yaml = normalised.slice(4, endIndex);
  const body = normalised.slice(endIndex + 4).trim();
  const frontmatter: Frontmatter = {};
  for (const line of yaml.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (match) frontmatter[match[1]!] = match[2]!.trim();
  }
  return { frontmatter, body };
}

/** Emit a `---`-delimited frontmatter block from ordered `key: value` entries (no trailing newline). */
export function serialiseFrontmatter(entries: readonly (readonly [string, string])[]): string {
  return ["---", ...entries.map(([k, v]) => `${k}: ${v}`), "---"].join("\n");
}
