export interface OpenCodeReadOutput {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly content: string;
}

export function parseOpenCodeReadOutput(output: string): OpenCodeReadOutput | null {
  const match =
    /^<path>([^\r\n]+)<\/path>\r?\n<type>(file|directory)<\/type>\r?\n<content>(?:\r?\n)?/u.exec(
      output,
    );
  const path = match?.[1]?.trim();
  const type = match?.[2];
  if (!match || !path || (type !== "file" && type !== "directory")) {
    return null;
  }
  // Historical activity details may end before the closing tag because ingestion truncates them.
  const content = output
    .slice(match[0].length)
    .replace(/(?:\r?\n)?<\/content>[ \t]*(?:\r?\n)*$/u, "");
  return { path, type, content };
}
