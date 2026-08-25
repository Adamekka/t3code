import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import {
  OPEN_CODE_GREP_MATCH_LIMIT,
  parseOpenCodeGrepOutput,
  parseOpenCodeReadOutput,
  parseOpenCodeTaskEnvelope,
} from "../provider/OpenCodeToolOutput.ts";

const MAX_PROJECTED_GREP_PATH_LENGTH = 512;
const MAX_PROJECTED_GREP_LINE_CONTENT_LENGTH = 160;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function projectCommandData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  if (!item) {
    return undefined;
  }

  const projectedItem: Record<string, unknown> = {};
  if ("command" in item) {
    projectedItem.command = item.command;
  }

  const aggregatedOutput = asTrimmedString(item.aggregatedOutput);
  if (aggregatedOutput) {
    const summary = summarizeToolTextOutput(aggregatedOutput);
    if (summary) {
      projectedItem.aggregatedOutput = summary;
    }
  }

  const input = asRecord(item.input);
  if (input && "command" in input) {
    projectedItem.input = { command: input.command };
  }

  const result = asRecord(item.result);
  if (result) {
    const projectedResult: Record<string, unknown> = {};
    if ("command" in result) {
      projectedResult.command = result.command;
    }
    const content = asTrimmedString(result.content);
    if (content) {
      const summary = summarizeToolTextOutput(content);
      if (summary) {
        projectedResult.content = summary;
      }
    }
    if (Object.keys(projectedResult).length > 0) {
      projectedItem.result = projectedResult;
    }
  }

  return Object.keys(projectedItem).length > 0 ? projectedItem : undefined;
}

function projectCommandValue(data: Record<string, unknown>): unknown {
  if (data.command !== undefined) {
    return data.command;
  }

  const input = asRecord(data.input);
  if (input?.command !== undefined) {
    return input.command;
  }

  const stateInput = asRecord(asRecord(data.state)?.input);
  if (stateInput?.command !== undefined) {
    return stateInput.command;
  }

  return undefined;
}

function projectViewedImagePath(data: Record<string, unknown>): string | undefined {
  const directPath = asTrimmedString(data.imagePath);
  if (directPath && isWorkspaceImagePreviewPath(directPath)) {
    return directPath;
  }

  const toolName = asTrimmedString(data.toolName)?.toLowerCase();
  if (toolName !== "read" && toolName !== "read file") {
    return undefined;
  }
  const input = asRecord(data.input);
  const inputPath = asTrimmedString(input?.file_path) ?? asTrimmedString(input?.path);
  return inputPath && isWorkspaceImagePreviewPath(inputPath) ? inputPath : undefined;
}

function summarizeToolTextOutput(value: string): string | null {
  let meaningfulLineCount = 0;
  let offset = 0;

  while (offset <= value.length) {
    const newlineIndex = value.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? value.length : newlineIndex;
    const line = value.slice(offset, lineEnd).replace(/\s+/g, " ").trim();
    if (line.length > 0) {
      meaningfulLineCount += 1;
      if (line !== "```") {
        const summary = line.length <= 84 ? line : `${line.slice(0, 83).trimEnd()}…`;
        // V8 can retain the full tool output behind a short sliced string.
        // Join a tiny character array so the returned preview owns its bytes.
        return Array.from(summary).join("");
      }
    }
    if (newlineIndex === -1) {
      break;
    }
    offset = newlineIndex + 1;
  }

  return meaningfulLineCount > 1 ? `${meaningfulLineCount.toLocaleString()} lines` : null;
}

/**
 * Fields of an MCP tool-call item both clients render in the expanded
 * work-log row. Everything else — notably `result`, which carries the full
 * tool output and dominates wire size on MCP-heavy threads — is summarized
 * or dropped. Full payloads remain in persistence.
 */
const MCP_ITEM_KEPT_FIELDS = [
  "type",
  "id",
  "tool",
  "server",
  "status",
  "arguments",
  "appContext",
  "error",
  "durationMs",
] as const;

/**
 * Pulls renderable text out of an MCP tool result: either a Codex-style
 * `{content: [{type: "text", text}, ...]}` record or a raw Claude
 * `tool_result` block whose `content` is a string or block array.
 */
function extractMcpResultText(result: unknown): string | null {
  const record = asRecord(result);
  if (!record) {
    return typeof result === "string" ? result : null;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    const texts: string[] = [];
    for (const entry of record.content) {
      const text = asRecord(entry)?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        texts.push(text);
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  return null;
}

function summarizeMcpResult(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  const text = extractMcpResultText(result);
  const summary = text ? summarizeToolTextOutput(text) : null;
  return summary ? { content: summary } : undefined;
}

/**
 * MCP tool calls carry full tool results (`data.item.result` on Codex,
 * `data.result` on Claude/OpenCode) that used to bypass slimming entirely to
 * keep the expanded-row UI working. Keep the fields the UI actually renders
 * and summarize the result like regular tool output.
 */
function projectMcpToolCallData(data: Record<string, unknown>): Record<string, unknown> {
  const projectedData: Record<string, unknown> = {};

  const item = asRecord(data.item);
  if (item) {
    const projectedItem: Record<string, unknown> = {};
    for (const key of MCP_ITEM_KEPT_FIELDS) {
      if (key in item) {
        projectedItem[key] = item[key];
      }
    }
    const result = summarizeMcpResult(item.result);
    if (result) {
      projectedItem.result = result;
    }
    projectedData.item = projectedItem;
  }

  if ("toolName" in data) {
    projectedData.toolName = data.toolName;
  }
  if ("input" in data) {
    projectedData.input = data.input;
  }
  if (!item) {
    const result = summarizeMcpResult(data.result);
    if (result) {
      projectedData.result = result;
    }
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }
  if ("kind" in data) {
    projectedData.kind = data.kind;
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  return projectedData;
}

function projectRawOutput(value: unknown): Record<string, unknown> | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    const summary = summarizeToolTextOutput(direct);
    return summary ? { content: summary } : undefined;
  }

  const rawOutput = asRecord(value);
  if (!rawOutput) {
    return undefined;
  }

  if (typeof rawOutput.totalFiles === "number" && Number.isFinite(rawOutput.totalFiles)) {
    return {
      totalFiles: rawOutput.totalFiles,
      ...(rawOutput.truncated === true ? { truncated: true } : {}),
    };
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    const summary = summarizeToolTextOutput(content);
    return summary ? { content: summary } : undefined;
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    const summary = summarizeToolTextOutput(stdout);
    return summary ? { content: summary } : undefined;
  }

  const stderr = asTrimmedString(rawOutput.stderr);
  if (stderr) {
    const summary = summarizeToolTextOutput(stderr);
    return summary ? { content: summary } : undefined;
  }

  return undefined;
}

function projectAcpContent(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const text = value
    .map((entryValue) => {
      const entry = asRecord(entryValue);
      const content = asRecord(entry?.content);
      return entry?.type === "content" && content?.type === "text"
        ? asTrimmedString(content.text)
        : null;
    })
    .filter((entry): entry is string => entry !== null)
    .join("\n");
  const summary = summarizeToolTextOutput(text);
  return summary ? { content: summary } : undefined;
}

/**
 * Removes activity payload fields that no current client reads while retaining
 * the full payload in persistence and the event store.
 */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  if (!payload || !data) {
    return activity;
  }

  const itemStatus = asRecord(data.item)?.status;
  const statusProjectedPayload =
    payload.status === "completed" && (itemStatus === "failed" || itemStatus === "declined")
      ? { ...payload, status: itemStatus }
      : payload;

  if (payload.itemType === "mcp_tool_call") {
    return {
      ...activity,
      payload: {
        ...statusProjectedPayload,
        data: projectMcpToolCallData(data),
      },
    };
  }

  const projectedData: Record<string, unknown> = {};
  const state = asRecord(data.state);
  const input = asRecord(state?.input);
  const directInput = asRecord(data.input);
  const rawInput = asRecord(data.rawInput);
  const isReadActivity =
    data.tool === "read" ||
    data.kind === "read" ||
    activity.summary.trim().toLowerCase() === "read";
  const isGlobActivity =
    data.tool === "glob" ||
    data.kind === "glob" ||
    activity.summary.trim().toLowerCase() === "glob";
  const toolName = asTrimmedString(data.tool) ?? asTrimmedString(data.toolName);
  const normalizedToolName = toolName?.toLowerCase();
  const isOpenCodeEditActivity = normalizedToolName === "edit";
  const isOpenCodeApplyPatchActivity =
    normalizedToolName === "apply_patch" || data.kind === "apply_patch";
  const isOpenCodeWriteActivity = normalizedToolName === "write";
  const isOpenCodeGrepActivity = normalizedToolName === "grep";
  // Historical projected rows may retain only the generic activity summary and detail.
  const isOpenCodeSkillActivity =
    toolName?.toLowerCase() === "skill" ||
    data.kind === "skill" ||
    activity.summary.trim().toLowerCase() === "skill";
  const isOpenCodeTaskActivity =
    toolName?.toLowerCase() === "task" ||
    data.kind === "task" ||
    activity.summary.trim().toLowerCase() === "task";
  const isSearchActivity =
    toolName?.toLowerCase() === "grep" ||
    payload.itemType === "web_search" ||
    data.kind === "search" ||
    data.kind === "fetch";
  const isTodoActivity = toolName?.toLowerCase() === "todowrite" || data.kind === "todo";
  const readOutput =
    isReadActivity && typeof payload.detail === "string"
      ? parseOpenCodeReadOutput(payload.detail)
      : null;
  const readInputPath =
    isReadActivity && typeof input?.filePath === "string" ? input.filePath.trim() : "";
  const readPath = readOutput?.path ?? readInputPath;
  const editMetadata = isOpenCodeEditActivity ? asRecord(state?.metadata) : null;
  const editFileDiff = asRecord(editMetadata?.filediff);
  const editInputPath = isOpenCodeEditActivity
    ? (asTrimmedString(input?.filePath) ?? asTrimmedString(editFileDiff?.file) ?? "")
    : "";
  const metadataEditPatch =
    typeof editMetadata?.diff === "string" && editMetadata.diff.trim().length > 0
      ? editMetadata.diff
      : null;
  const fileEditPatch =
    typeof editFileDiff?.patch === "string" && editFileDiff.patch.trim().length > 0
      ? editFileDiff.patch
      : null;
  const editPatch =
    isOpenCodeEditActivity && statusProjectedPayload.status === "completed"
      ? (metadataEditPatch ?? fileEditPatch)
      : null;
  const applyPatchEdits: Array<{ path: string; patch: string }> = [];
  if (isOpenCodeApplyPatchActivity && statusProjectedPayload.status === "completed") {
    const metadataFiles = asRecord(state?.metadata)?.files;
    const rawEdits = Array.isArray(metadataFiles)
      ? metadataFiles
      : data.kind === "apply_patch" && Array.isArray(data.edits)
        ? data.edits
        : null;
    if (rawEdits && rawEdits.length > 0) {
      for (const rawEdit of rawEdits) {
        const edit = asRecord(rawEdit);
        const path =
          asTrimmedString(edit?.relativePath) ??
          asTrimmedString(edit?.movePath) ??
          asTrimmedString(edit?.filePath) ??
          asTrimmedString(edit?.path);
        const patch =
          typeof edit?.patch === "string" && edit.patch.trim().length > 0 ? edit.patch : null;
        if (!path || !patch) {
          // A partial split would hide files from a successful provider call.
          applyPatchEdits.length = 0;
          break;
        }
        applyPatchEdits.push({ path, patch });
      }
    }
  }
  const writeInputPath =
    isOpenCodeWriteActivity && typeof input?.filePath === "string" ? input.filePath.trim() : "";
  const writeContent =
    isOpenCodeWriteActivity &&
    statusProjectedPayload.status === "completed" &&
    typeof input?.content === "string"
      ? input.content
      : null;
  const skillMetadata = isOpenCodeSkillActivity ? asRecord(state?.metadata) : null;
  const projectedSkillName = isOpenCodeSkillActivity
    ? (asTrimmedString(data.name) ??
      asTrimmedString(input?.name) ??
      asTrimmedString(skillMetadata?.name))
    : null;
  let skillName = projectedSkillName;
  let skillMarkdown: string | undefined =
    isOpenCodeSkillActivity &&
    statusProjectedPayload.status === "completed" &&
    data.detailFormat === "markdown"
      ? typeof payload.detail === "string"
        ? payload.detail
        : ""
      : undefined;
  if (
    skillMarkdown === undefined &&
    isOpenCodeSkillActivity &&
    statusProjectedPayload.status === "completed"
  ) {
    const output =
      typeof state?.output === "string"
        ? state.output.trim()
        : typeof payload.detail === "string"
          ? payload.detail.trim()
          : "";
    const openingTag = /^<skill_content name="([^"\r\n]+)">\r?\n/u.exec(output);
    const closingTag = "</skill_content>";
    if (openingTag && output.endsWith(closingTag)) {
      const envelopeName = openingTag[1]!;
      const inner = output
        .slice(openingTag[0].length, -closingTag.length)
        .replace(/\r\n/gu, "\n")
        .trimEnd();
      const generatedHeading = `# Skill: ${envelopeName}`;
      const footerStart = inner.lastIndexOf("\nBase directory for this skill:");
      if (inner.startsWith(`${generatedHeading}\n`) && footerStart > generatedHeading.length) {
        const markdown = inner.slice(generatedHeading.length, footerStart).trim();
        skillName = skillName ?? envelopeName;
        skillMarkdown = markdown;
      }
    }
  }
  const taskDescription = isOpenCodeTaskActivity
    ? (asTrimmedString(data.description) ?? asTrimmedString(input?.description))
    : null;
  const taskEnvelope = isOpenCodeTaskActivity
    ? parseOpenCodeTaskEnvelope(typeof state?.output === "string" ? state.output : payload.detail)
    : null;
  const taskMarkdown =
    isOpenCodeTaskActivity &&
    statusProjectedPayload.status === "completed" &&
    (data.detailFormat === "markdown" || taskEnvelope?.state === "completed")
      ? (taskEnvelope?.result ?? (typeof payload.detail === "string" ? payload.detail : ""))
      : undefined;
  const grepOutput =
    isOpenCodeGrepActivity && typeof state?.output === "string"
      ? parseOpenCodeGrepOutput(state.output)
      : isOpenCodeGrepActivity && typeof payload.detail === "string"
        ? parseOpenCodeGrepOutput(payload.detail)
        : null;
  const globPattern = isGlobActivity
    ? typeof data.pattern === "string"
      ? data.pattern.trim()
      : typeof input?.pattern === "string"
        ? input.pattern.trim()
        : ""
    : "";
  const todos: Array<{
    content: string;
    status: "pending" | "inProgress" | "completed" | "cancelled";
  }> = [];
  if (isTodoActivity) {
    const rawTodos = Array.isArray(data.todos)
      ? data.todos
      : Array.isArray(directInput?.todos)
        ? directInput.todos
        : Array.isArray(input?.todos)
          ? input.todos
          : [];
    for (const rawTodo of rawTodos) {
      const todo = asRecord(rawTodo);
      const content = asTrimmedString(todo?.content);
      if (!content) {
        continue;
      }
      const rawStatus = todo?.status;
      const status =
        rawStatus === "completed" || rawStatus === "cancelled" || rawStatus === "pending"
          ? rawStatus
          : rawStatus === "in_progress" || rawStatus === "inProgress"
            ? "inProgress"
            : null;
      if (!status) {
        continue;
      }
      todos.push({ content, status });
    }
  }
  const item = projectCommandData(data);
  if (item) {
    projectedData.item = item;
  }
  const command = projectCommandValue(data);
  if (command !== undefined) {
    projectedData.command = command;
  }
  const imagePath = projectViewedImagePath(data);
  if (imagePath) {
    projectedData.imagePath = imagePath;
  }

  const changedFiles: string[] = [];
  const seenChangedFiles = new Set<string>();
  if (readPath) {
    pushChangedFile(changedFiles, seenChangedFiles, readPath);
  }
  if (editInputPath) {
    pushChangedFile(changedFiles, seenChangedFiles, editInputPath);
  }
  if (writeInputPath) {
    pushChangedFile(changedFiles, seenChangedFiles, writeInputPath);
  }
  for (const edit of applyPatchEdits) {
    pushChangedFile(changedFiles, seenChangedFiles, edit.path);
  }
  collectChangedFiles(data, changedFiles, seenChangedFiles, 0);
  if (changedFiles.length > 0) {
    // Both clients discover file names by walking objects with path-like keys.
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }
  if (isReadActivity) {
    projectedData.kind = "read";
  } else if (isGlobActivity) {
    projectedData.kind = "glob";
  } else if (isTodoActivity) {
    projectedData.kind = "todo";
    projectedData.todos = todos;
  } else if (isOpenCodeSkillActivity) {
    projectedData.kind = "skill";
  } else if (isOpenCodeTaskActivity) {
    projectedData.kind = "task";
  } else if (isOpenCodeApplyPatchActivity) {
    projectedData.kind = "apply_patch";
  } else if (isSearchActivity) {
    projectedData.kind = "search";
  } else if ("kind" in data) {
    projectedData.kind = data.kind;
  }
  if ("toolName" in data) {
    projectedData.toolName = data.toolName;
  }
  if (globPattern) {
    projectedData.pattern = globPattern;
  }
  if (editInputPath && editPatch) {
    projectedData.edit = { path: editInputPath, patch: editPatch };
  }
  if (applyPatchEdits.length > 0) {
    projectedData.edits = applyPatchEdits;
  }
  if (skillName) {
    projectedData.name = skillName;
  }
  if (skillMarkdown !== undefined) {
    projectedData.detailFormat = "markdown";
  }
  if (taskDescription) {
    projectedData.description = taskDescription;
  }
  if (taskMarkdown !== undefined) {
    projectedData.detailFormat = "markdown";
  }
  if (isSearchActivity) {
    const searchInput = rawInput ?? input;
    const searchQuery =
      asTrimmedString(searchInput?.query) ??
      asTrimmedString(searchInput?.pattern) ??
      asTrimmedString(searchInput?.searchTerm) ??
      asTrimmedString(searchInput?.url);
    if (searchQuery) {
      projectedData.rawInput = { query: searchQuery };
    }

    const rawSearchMatches = grepOutput?.matches ?? data.searchMatches;
    if (Array.isArray(rawSearchMatches)) {
      const searchMatches: Array<{
        path: string;
        lineNumber: number;
        lineContent: string;
      }> = [];
      for (const rawMatch of rawSearchMatches.slice(0, OPEN_CODE_GREP_MATCH_LIMIT)) {
        if (searchMatches.length === OPEN_CODE_GREP_MATCH_LIMIT) {
          break;
        }
        const match = asRecord(rawMatch);
        const path = asTrimmedString(match?.path);
        const lineNumber = match?.lineNumber;
        if (
          !path ||
          path.length > MAX_PROJECTED_GREP_PATH_LENGTH ||
          typeof lineNumber !== "number" ||
          !Number.isSafeInteger(lineNumber) ||
          lineNumber < 1 ||
          typeof match?.lineContent !== "string"
        ) {
          continue;
        }
        const lineContent =
          match.lineContent.length > MAX_PROJECTED_GREP_LINE_CONTENT_LENGTH
            ? `${match.lineContent.slice(0, MAX_PROJECTED_GREP_LINE_CONTENT_LENGTH - 3)}...`
            : match.lineContent;
        searchMatches.push({ path, lineNumber, lineContent });
      }
      if (searchMatches.length > 0) {
        projectedData.searchMatches = searchMatches;
        const rawMatchCount = grepOutput?.totalMatches ?? data.searchMatchCount;
        if (
          typeof rawMatchCount === "number" &&
          Number.isSafeInteger(rawMatchCount) &&
          rawMatchCount >= searchMatches.length
        ) {
          projectedData.searchMatchCount = rawMatchCount;
        }
      }
    }
  }

  const rawOutput =
    projectRawOutput(data.rawOutput) ??
    projectAcpContent(data.content) ??
    (payload.itemType === "command_execution" ? summarizeMcpResult(data.result) : undefined);
  if (rawOutput) {
    projectedData.rawOutput = rawOutput;
  }

  const normalizedPayload: Record<string, unknown> = {
    ...statusProjectedPayload,
    ...(taskEnvelope?.state === "error" ? { status: "failed" } : {}),
  };
  if (readOutput) {
    if (readOutput.content.trim().length > 0) {
      normalizedPayload.detail = readOutput.content;
    } else {
      delete normalizedPayload.detail;
    }
  }
  if (grepOutput && grepOutput.matches.length > 0) {
    delete normalizedPayload.detail;
  } else if (isOpenCodeGrepActivity && typeof payload.detail === "string") {
    const grepDetail = payload.detail.replace(/^Found [0-9]+ match(?:es)?\r?\n/u, "");
    if (grepDetail.trim().length > 0) {
      normalizedPayload.detail = grepDetail;
    } else {
      delete normalizedPayload.detail;
    }
  }
  if (isTodoActivity && payload.status !== "failed") {
    delete normalizedPayload.detail;
  }
  if (writeContent !== null) {
    if (writeContent.length > 0) {
      normalizedPayload.detail = writeContent;
    } else {
      delete normalizedPayload.detail;
    }
  } else if (
    isOpenCodeWriteActivity &&
    statusProjectedPayload.status === "completed" &&
    payload.detail === "Wrote file successfully." &&
    changedFiles.length > 0
  ) {
    delete normalizedPayload.detail;
  }
  if (
    isOpenCodeEditActivity &&
    statusProjectedPayload.status === "completed" &&
    payload.detail === "Edit applied successfully." &&
    changedFiles.length > 0
  ) {
    delete normalizedPayload.detail;
  }
  if (skillMarkdown !== undefined) {
    if (skillMarkdown.length > 0) {
      normalizedPayload.detail = skillMarkdown;
    } else {
      delete normalizedPayload.detail;
    }
  }
  if (taskMarkdown !== undefined) {
    if (taskMarkdown.length > 0) {
      normalizedPayload.detail = taskMarkdown;
    } else {
      delete normalizedPayload.detail;
    }
  } else if (taskEnvelope) {
    const taskDetail = taskEnvelope.error ?? taskEnvelope.result;
    if (taskDetail) {
      normalizedPayload.detail = taskDetail;
    } else {
      delete normalizedPayload.detail;
    }
  }

  return {
    ...activity,
    payload: {
      ...normalizedPayload,
      data: projectedData,
    },
  };
}

/**
 * Matches the validity rule in the web client's
 * `deriveLatestContextWindowSnapshot`: rows without a finite, non-negative
 * `usedTokens` are skipped during its backward walk, so they must not shadow
 * an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const payload = asRecord(activity.payload);
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Drops all but the last resolvable context-window activity per turn from a
 * snapshot. Clients only ever read the latest usage value (walking the array
 * backwards), so shipping the full history — often thousands of rows on long
 * threads — buys nothing. Retention is per turn rather than per thread because
 * a live `thread.reverted` makes the client discard whole turns; keeping each
 * turn's latest row means the meter can still resolve a value from the turns
 * that survive. Malformed rows pass through untouched rather than shadowing a
 * valid earlier row. Live `thread.activity-appended` events are untouched:
 * newer updates still stream through and supersede the retained rows on the
 * client.
 */
function dropStaleContextWindowActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestIndexByTurn = new Map<string | null, number>();
  for (let index = 0; index < activities.length; index += 1) {
    if (isResolvableContextWindowActivity(activities[index]!)) {
      latestIndexByTurn.set(activities[index]!.turnId, index);
    }
  }
  if (latestIndexByTurn.size === 0) {
    return activities;
  }
  return activities.filter(
    (activity, index) =>
      !isResolvableContextWindowActivity(activity) ||
      latestIndexByTurn.get(activity.turnId) === index,
  );
}

/**
 * Identity used to retain only the newest lifecycle row for each call in a
 * thread snapshot. Prefer the runtime item id, then the legacy nested id, and
 * finally the itemType/title/detail triple. Rows without any identity remain
 * untouched.
 */
function toolLifecycleIdentity(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  if (!payload) {
    return null;
  }

  const toolCallId =
    asTrimmedString(payload.toolCallId) ?? asTrimmedString(asRecord(payload.data)?.toolCallId);
  if (toolCallId) {
    return `id:${toolCallId}`;
  }

  const itemType = asTrimmedString(payload.itemType) ?? "";
  // Mirrors the clients' `normalizeCompactToolLabel`: a completion's title may
  // gain a trailing "complete"/"completed" the in-flight updates lack.
  const label = (asTrimmedString(payload.title) ?? activity.summary)
    .replace(/\s+(?:complete|completed)\s*$/iu, "")
    .trim();
  const detail = asTrimmedString(payload.detail) ?? "";
  if (itemType.length === 0 && label.length === 0 && detail.length === 0) {
    return null;
  }
  return [itemType, label, detail].join("");
}

/**
 * Drops `tool.updated` rows a `tool.completed` row already supersedes. An
 * update is the in-flight snapshot of a call; once the call completes, the
 * completion carries the final state and the clients fold every matching
 * update into it, so shipping the updates buys nothing — 47k such rows exist
 * in one real database, and a single thread carries 2,291 of them totalling
 * ~1MB post-slimming.
 *
 * Matching is per turn for the same reason `dropStaleContextWindowActivities`
 * retains per turn: a live `thread.reverted` makes the client discard whole
 * turns, so a completion in a different turn could vanish and leave the
 * dropped update unrepresented. The completion must also come *after* the
 * update within the turn — a later update belongs to a subsequent call that
 * reuses the same identity and is still in flight. Rows without a lifecycle
 * identity pass through, matching the clients, which never collapse them.
 * Deliberate divergence from client collapse: clients fold only *adjacent*
 * lifecycle rows, so a superseded update separated from its completion by an
 * interleaved parallel call renders as its own row today, and this drop
 * removes it. Measured against a real database, that affects 1.5% of dropped
 * rows (553 of 36,581), all pure in-flight state whose final result the
 * retained completion still shows. Dropping them is intentional; matching
 * adjacency server-side would forfeit most of the win for parallel-heavy
 * threads, which are exactly the heavy ones. Superseding completions always
 * carry a payload superset of their updates (verified across all 49,515
 * update rows: zero dropped rows held a client-merged field — detail, title,
 * command, item, kind, files — their completion lacked), so no expanded-row
 * content is lost.
 */
function dropSupersededToolUpdatedActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const completionIndicesByKey = new Map<string, number[]>();
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index]!;
    if (activity.kind !== "tool.completed") {
      continue;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      continue;
    }
    const key = `${activity.turnId ?? ""}\u0000${identity}`;
    const indices = completionIndicesByKey.get(key);
    if (indices) {
      indices.push(index);
    } else {
      completionIndicesByKey.set(key, [index]);
    }
  }
  if (completionIndicesByKey.size === 0) {
    return activities;
  }

  return activities.filter((activity, index) => {
    if (activity.kind !== "tool.updated") {
      return true;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      return true;
    }
    const indices = completionIndicesByKey.get(`${activity.turnId ?? ""}\u0000${identity}`);
    return !indices?.some((completionIndex) => completionIndex > index);
  });
}

export function projectThreadDetailSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      activities: dropSupersededToolUpdatedActivities(
        dropStaleContextWindowActivities(snapshot.thread.activities),
      ).map(projectActivityPayload),
    },
  };
}

export function projectActivityEvent(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type !== "thread.activity-appended") {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      activity: projectActivityPayload(event.payload.activity),
    },
  };
}
