export interface OpenCodeReadOutput {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly content: string;
}

export interface OpenCodeGrepMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly lineContent: string;
}

export interface OpenCodeGrepOutput {
  readonly totalMatches: number;
  readonly matches: ReadonlyArray<OpenCodeGrepMatch>;
  readonly content: string;
}

export const OPEN_CODE_GREP_MATCH_LIMIT = 5;

export function parseOpenCodeReadOutput(output: string): OpenCodeReadOutput | null {
  const match =
    /^<path>([^\r\n]+)<\/path>\r?\n<type>(file|directory)<\/type>\r?\n<(content|entries)>(?:\r?\n)?/u.exec(
      output,
    );
  const path = match?.[1]?.trim();
  const type = match?.[2];
  const bodyTag = match?.[3];
  if (
    !match ||
    !path ||
    (type !== "file" && type !== "directory") ||
    (bodyTag !== "content" && bodyTag !== "entries")
  ) {
    return null;
  }
  // Historical activity details may end before the closing tag because ingestion truncates them.
  const content = output
    .slice(match[0].length)
    .replace(
      bodyTag === "content"
        ? /(?:\r?\n)?<\/content>[ \t]*(?:\r?\n)*$/u
        : /(?:\r?\n)?<\/entries>[ \t]*(?:\r?\n)*$/u,
      "",
    );
  return { path, type, content };
}

export function parseOpenCodeGrepOutput(output: string): OpenCodeGrepOutput | null {
  const header = /^Found ([0-9]+) match(?:es)?\r?\n/u.exec(output);
  const totalMatches = header ? Number(header[1]) : Number.NaN;
  if (!header || !Number.isSafeInteger(totalMatches)) {
    return null;
  }

  const content = output.slice(header[0].length);
  const matches: OpenCodeGrepMatch[] = [];
  let path: string | null = null;
  let pathHasMatch = false;
  let offset = 0;
  while (offset <= content.length) {
    const newlineIndex = content.indexOf("\n", offset);
    const rawLine = content.slice(offset, newlineIndex === -1 ? content.length : newlineIndex);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    offset = newlineIndex === -1 ? content.length + 1 : newlineIndex + 1;
    if (line.trim().length === 0) {
      continue;
    }

    const match = /^\s+Line ([1-9][0-9]*): ?(.*)$/u.exec(line);
    if (match) {
      const lineNumber = Number(match[1]);
      if (!path || !Number.isSafeInteger(lineNumber)) {
        return null;
      }
      pathHasMatch = true;
      if (matches.length < OPEN_CODE_GREP_MATCH_LIMIT) {
        matches.push({ path, lineNumber, lineContent: match[2] ?? "" });
      }
      continue;
    }

    if (/^\S.*:$/u.test(line)) {
      if (path && !pathHasMatch) {
        return null;
      }
      path = line.slice(0, -1).trim();
      if (!path) {
        return null;
      }
      pathHasMatch = false;
      continue;
    }

    return null;
  }

  if (
    (path && !pathHasMatch) ||
    matches.length > totalMatches ||
    (totalMatches > 0 && matches.length === 0)
  ) {
    return null;
  }
  return { totalMatches, matches, content };
}
