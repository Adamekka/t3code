import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps a bounded Codex command output summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput: "hello from codex",
    });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps preview normalization and fence-only fallback while scanning lines", () => {
    const preview = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: { rawOutput: `\`\`\`\n  actual\tresult  \n${"x".repeat(5000)}` },
      }),
    );
    const fences = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: { rawOutput: "```\r\n \t \n```\n" },
      }),
    );

    expect((preview.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "actual result",
    });
    expect((fences.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "2 lines",
    });
  });

  it("keeps bounded Claude and ACP command output summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: `hello from claude\n${"y".repeat(5000)}` },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: `hello from acp\n${"z".repeat(5000)}` },
            },
          ],
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData.rawOutput).toEqual({ content: "hello from claude" });
    expect(acpData.rawOutput).toEqual({ content: "hello from acp" });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(500);
    expect(JSON.stringify(acp.payload).length).toBeLessThan(500);
  });

  it.each(["failed", "declined"] as const)(
    "preserves a tool item's %s status when the outer payload says completed",
    (status) => {
      const projected = projectActivityPayload(
        activity({
          itemType: "command_execution",
          status: "completed",
          data: {
            item: {
              status,
              command: "vp test run",
            },
          },
        }),
      );

      expect(projected.payload).toMatchObject({
        status,
        data: { item: { command: "vp test run" } },
      });
    },
  );

  it("normalizes Claude and OpenCode command inputs before slimming provider data", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "claude-call-1",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
          result: { content: "x".repeat(5_000) },
        },
      }),
    );
    const openCode = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "opencode-call-1",
        data: {
          tool: "bash",
          state: {
            status: "running",
            input: { command: "vp lint" },
            output: "x".repeat(5_000),
          },
        },
      }),
    );

    expect(claude.payload).toMatchObject({
      toolCallId: "claude-call-1",
      data: { command: "vp test run" },
    });
    expect(openCode.payload).toMatchObject({
      toolCallId: "opencode-call-1",
      data: { command: "vp lint" },
    });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(200);
    expect(JSON.stringify(openCode.payload).length).toBeLessThan(200);
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });

  it("recovers commands from stored OpenCode bash tool state", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        detail: "package.json\nsrc",
        data: {
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "package.json\nsrc",
          },
        },
      }),
    );

    expect((projected.payload as Record<string, unknown>).detail).toBe("package.json\nsrc");
    expect((projected.payload as Record<string, unknown>).data).toEqual({ command: "ls" });
  });

  it("retains OpenCode's written path and full contents", () => {
    const contents = "export const value = 1;\n\n";
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        status: "completed",
        detail: "Wrote file successfully.",
        data: {
          tool: "write",
          state: {
            status: "completed",
            input: { filePath: "/workspace/src/index.ts", content: contents },
            output: "Wrote file successfully.",
          },
        },
      }),
    );

    expect((projected.payload as Record<string, unknown>).detail).toBe(contents);
    expect((projected.payload as Record<string, unknown>).data).toEqual({
      files: [{ path: "/workspace/src/index.ts" }],
    });
  });

  it("retains OpenCode's edited path and unified patch", () => {
    const patch = [
      "Index: /workspace/src/index.ts",
      "===================================================================",
      "--- /workspace/src/index.ts",
      "+++ /workspace/src/index.ts",
      "@@ -1,1 +1,1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "",
    ].join("\n");
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        status: "completed",
        detail: "Edit applied successfully.",
        data: {
          tool: "edit",
          state: {
            status: "completed",
            input: {
              filePath: "/workspace/src/index.ts",
              oldString: "export const value = 1;",
              newString: "export const value = 2;",
            },
            output: "Edit applied successfully.",
            metadata: { diff: patch },
          },
        },
      }),
    );

    expect((projected.payload as Record<string, unknown>).detail).toBeUndefined();
    expect((projected.payload as Record<string, unknown>).data).toEqual({
      files: [{ path: "/workspace/src/index.ts" }],
      edit: { path: "/workspace/src/index.ts", patch },
    });
  });

  it("preserves failed OpenCode edit details", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        status: "failed",
        detail: "The old text was not found.",
        data: {
          tool: "edit",
          state: {
            status: "error",
            input: { filePath: "/workspace/src/index.ts" },
            error: "The old text was not found.",
          },
        },
      }),
    );

    expect((projected.payload as Record<string, unknown>).detail).toBe(
      "The old text was not found.",
    );
    expect((projected.payload as Record<string, unknown>).data).toEqual({
      files: [{ path: "/workspace/src/index.ts" }],
    });
  });

  it("uses OpenCode's filediff when top-level Edit metadata is incomplete", () => {
    const patch =
      "--- /workspace/src/index.ts\n+++ /workspace/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        status: "completed",
        detail: "Edit applied successfully.",
        data: {
          tool: "edit",
          state: {
            status: "completed",
            input: {},
            output: "Edit applied successfully.",
            metadata: {
              filediff: { file: "/workspace/src/index.ts", patch },
            },
          },
        },
      }),
    );

    expect((projected.payload as Record<string, unknown>).data).toEqual({
      files: [{ path: "/workspace/src/index.ts" }],
      edit: { path: "/workspace/src/index.ts", patch },
    });
  });

  it.each([
    {
      name: "failed",
      status: "failed",
      detail: "EACCES: permission denied",
      input: { filePath: "/workspace/src/index.ts" },
    },
    {
      name: "pathless",
      status: "completed",
      detail: "Wrote file successfully.",
      input: {},
    },
  ])("preserves $name OpenCode write details", ({ status, detail, input }) => {
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        status,
        detail,
        data: {
          tool: "write",
          state: { status, input, output: detail },
        },
      }),
    );

    expect((projected.payload as Record<string, unknown>).detail).toBe(detail);
  });

  it("normalizes stored OpenCode read output and retains its path", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail:
          "<path>/workspace/AGENTS.md</path>\n<type>file</type>\n<content>\n1: # Instructions\n2: Keep it small.\n</content>",
        data: {
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/workspace/AGENTS.md" },
          },
        },
      }),
    );

    expect((projected.payload as Record<string, unknown>).detail).toBe(
      "1: # Instructions\n2: Keep it small.",
    );
    expect((projected.payload as Record<string, unknown>).data).toEqual({
      kind: "read",
      files: [{ path: "/workspace/AGENTS.md" }],
    });
  });

  it("preserves malformed OpenCode read output", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail: "<content>not a complete read envelope</content>",
        data: { tool: "read" },
      }),
    );

    expect((projected.payload as Record<string, unknown>).detail).toBe(
      "<content>not a complete read envelope</content>",
    );
  });

  it("normalizes stored OpenCode read output truncated before its closing tag", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail:
          "<path>/workspace/large.ts</path>\n<type>file</type>\n<content>\n1: export const value = 'truncated...",
        data: { tool: "read" },
      }),
    );

    expect((projected.payload as Record<string, unknown>).detail).toBe(
      "1: export const value = 'truncated...",
    );
  });

  it("normalizes OpenCode directory listings", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail:
          "<path>/workspace/src</path>\n<type>directory</type>\n<content>\nindex.ts\nserver.ts\n</content>\n\n",
        data: { tool: "read" },
      }),
    );

    expect((projected.payload as Record<string, unknown>).detail).toBe("index.ts\nserver.ts");
    expect((projected.payload as Record<string, unknown>).data).toEqual({
      kind: "read",
      files: [{ path: "/workspace/src" }],
    });
  });

  it("normalizes OpenCode directory entry envelopes", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail:
          "<path>/workspace</path>\n<type>directory</type>\n<entries>\n.git/\nAGENTS.md\npackage.json\n</entries>",
        data: { tool: "read" },
      }),
    );

    expect((projected.payload as Record<string, unknown>).detail).toBe(
      ".git/\nAGENTS.md\npackage.json",
    );
    expect((projected.payload as Record<string, unknown>).data).toEqual({
      kind: "read",
      files: [{ path: "/workspace" }],
    });
  });

  it("normalizes cached historical Read rows after tool metadata was projected away", () => {
    const projected = projectActivityPayload({
      ...activity({
        itemType: "dynamic_tool_call",
        detail:
          '<path>/workspace/opencode.json</path>\n<type>file</type>\n<content>\n1: {\n2:   "plugin": []\n</content>',
        data: {},
      }),
      summary: "Read",
    });

    expect((projected.payload as Record<string, unknown>).detail).toBe('1: {\n2:   "plugin": []');
    expect((projected.payload as Record<string, unknown>).data).toEqual({
      kind: "read",
      files: [{ path: "/workspace/opencode.json" }],
    });
  });

  it("retains the pattern from stored OpenCode Glob input", () => {
    const projected = projectActivityPayload({
      ...activity({
        itemType: "dynamic_tool_call",
        detail: "/workspace/src/index.ts\n/workspace/src/server.ts",
        data: {
          tool: "glob",
          state: {
            status: "completed",
            input: { pattern: "**/*.ts" },
          },
        },
      }),
      summary: "Glob",
    });

    expect((projected.payload as Record<string, unknown>).detail).toBe(
      "/workspace/src/index.ts\n/workspace/src/server.ts",
    );
    expect((projected.payload as Record<string, unknown>).data).toEqual({
      kind: "glob",
      pattern: "**/*.ts",
    });
    expect(projectActivityPayload(projected)).toEqual(projected);
  });

  it("retains bounded normalized OpenCode grep presentation data", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail: "Found 1 match\n/workspace/SKILL.md:\n  Line 9: proactive",
        data: {
          toolCallId: "call-grep",
          tool: "grep",
          kind: "search",
          rawInput: { pattern: "proactive", path: "/workspace/AGENTS.md" },
        },
      }),
    );

    expect((projected.payload as Record<string, unknown>).data).toEqual({
      toolCallId: "call-grep",
      kind: "search",
      rawInput: { query: "proactive" },
      searchMatches: [{ path: "/workspace/SKILL.md", lineNumber: 9, lineContent: "proactive" }],
      searchMatchCount: 1,
    });
    expect((projected.payload as Record<string, unknown>).detail).toBeUndefined();
    expect(projectActivityPayload(projected)).toEqual(projected);
  });

  it("recovers normalized grep presentation from stored OpenCode tool state", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail:
          "Found 6 matches\n/workspace/a.ts:\n  Line 1: proactive\n/workspace/b.ts:\n  Line 2: proactive\n/workspace/c.ts:\n  Line 3: proactive\n/workspace/d.ts:\n  Line 4: proactive\n/workspace/e.ts:\n  Line 5: proactive\n/workspace/f.ts:\n  Line 6: proactive",
        data: {
          tool: "grep",
          state: {
            status: "completed",
            input: { pattern: "proactive", path: "/workspace" },
            output:
              "Found 6 matches\n/workspace/a.ts:\n  Line 1: proactive\n/workspace/b.ts:\n  Line 2: proactive\n/workspace/c.ts:\n  Line 3: proactive\n/workspace/d.ts:\n  Line 4: proactive\n/workspace/e.ts:\n  Line 5: proactive\n/workspace/f.ts:\n  Line 6: proactive",
          },
        },
      }),
    );

    expect((projected.payload as Record<string, unknown>).data).toEqual({
      kind: "search",
      rawInput: { query: "proactive" },
      searchMatches: [
        { path: "/workspace/a.ts", lineNumber: 1, lineContent: "proactive" },
        { path: "/workspace/b.ts", lineNumber: 2, lineContent: "proactive" },
        { path: "/workspace/c.ts", lineNumber: 3, lineContent: "proactive" },
        { path: "/workspace/d.ts", lineNumber: 4, lineContent: "proactive" },
        { path: "/workspace/e.ts", lineNumber: 5, lineContent: "proactive" },
      ],
      searchMatchCount: 6,
    });
    expect((projected.payload as Record<string, unknown>).detail).toBeUndefined();
    expect(projectActivityPayload(projected)).toEqual(projected);
  });

  it("preserves malformed OpenCode grep output as bounded text", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail: "unexpected grep output",
        data: {
          tool: "grep",
          state: {
            status: "completed",
            input: { pattern: "proactive", path: "/workspace" },
          },
        },
      }),
    );

    expect((projected.payload as Record<string, unknown>).detail).toBe("unexpected grep output");
    expect((projected.payload as Record<string, unknown>).data).toEqual({
      kind: "search",
      rawInput: { query: "proactive" },
    });
  });

  it("projects a completed OpenCode Skill as a name and authored Markdown", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        status: "completed",
        detail: "provider detail is replaced by normalized content",
        data: {
          tool: "skill",
          state: {
            status: "completed",
            input: { name: "unslop" },
            output:
              '<skill_content name="unslop">\n# Skill: unslop\n\n# Unslop\n\nEdit text to remove AI patterns.\n\nBase directory for this skill: /skills/unslop\nRelative paths are relative to this base directory.\n<skill_files>\n</skill_files>\n</skill_content>',
            metadata: { name: "unslop", dir: "/skills/unslop" },
          },
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "dynamic_tool_call",
      status: "completed",
      detail: "# Unslop\n\nEdit text to remove AI patterns.",
      data: {
        kind: "skill",
        name: "unslop",
        detailFormat: "markdown",
      },
    });
    expect(projectActivityPayload(projected)).toEqual(projected);
  });

  it("preserves failed OpenCode Skill detail while retaining its name", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        status: "failed",
        detail: "Skill not found: missing-skill",
        data: {
          tool: "skill",
          state: {
            status: "failed",
            input: { name: "missing-skill" },
          },
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "dynamic_tool_call",
      status: "failed",
      detail: "Skill not found: missing-skill",
      data: { kind: "skill", name: "missing-skill" },
    });
    expect(projectActivityPayload(projected)).toEqual(projected);
  });

  it("preserves malformed completed OpenCode Skill output as plain detail", () => {
    const detail = '<skill_content name="unslop">\n# Skill: unslop\n\nTruncated output';
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        status: "completed",
        detail,
        data: {
          tool: "skill",
          state: {
            status: "completed",
            input: { name: "unslop" },
            output: detail,
          },
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "dynamic_tool_call",
      status: "completed",
      detail,
      data: { kind: "skill", name: "unslop" },
    });
    expect(projectActivityPayload(projected)).toEqual(projected);
  });

  it("does not expose the OpenCode wrapper for an empty Skill", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        status: "completed",
        detail: "provider detail",
        data: {
          tool: "skill",
          state: {
            status: "completed",
            input: { name: "empty" },
            output:
              '<skill_content name="empty">\n# Skill: empty\n\nBase directory for this skill: /skills/empty\nRelative paths are relative to this base directory.\n<skill_files>\n</skill_files>\n</skill_content>',
          },
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "dynamic_tool_call",
      status: "completed",
      data: { kind: "skill", name: "empty", detailFormat: "markdown" },
    });
    expect(projectActivityPayload(projected)).toEqual(projected);
  });

  it("projects a completed OpenCode Task as a description and authored Markdown", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "collab_agent_tool_call",
        status: "completed",
        detail: "provider detail is replaced by normalized content",
        data: {
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Trace task flow", subagent_type: "explore" },
            output:
              '<task id="child-task" state="completed">\n<task_result>\n## Result\n\nFound it.\n</task_result>\n</task>',
          },
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "collab_agent_tool_call",
      status: "completed",
      detail: "## Result\n\nFound it.",
      data: {
        kind: "task",
        description: "Trace task flow",
        detailFormat: "markdown",
      },
    });
    expect(projectActivityPayload(projected)).toEqual(projected);
  });

  it("strips a running OpenCode Task envelope without treating it as completed Markdown", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "collab_agent_tool_call",
        status: "completed",
        detail: "provider detail",
        data: {
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Research in background" },
            output:
              '<task id="child-task" state="running">\n<task_result>Background task launched.</task_result>\n</task>',
          },
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "collab_agent_tool_call",
      status: "completed",
      detail: "Background task launched.",
      data: { kind: "task", description: "Research in background" },
    });
    expect(projectActivityPayload(projected)).toEqual(projected);
  });

  it("projects an OpenCode Task error envelope as plain failed detail", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "collab_agent_tool_call",
        status: "completed",
        data: {
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Inspect failure" },
            output:
              '<task id="child-task" state="error">\n<task_error>Child failed.</task_error>\n</task>',
          },
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "collab_agent_tool_call",
      status: "failed",
      detail: "Child failed.",
      data: { kind: "task", description: "Inspect failure" },
    });
    expect(projectActivityPayload(projected)).toEqual(projected);
  });

  it("preserves malformed failed OpenCode Task detail as plain text", () => {
    const detail = '<task id="child-task" state="error">\n<task_error>Truncated';
    const projected = projectActivityPayload(
      activity({
        itemType: "collab_agent_tool_call",
        status: "failed",
        detail,
        data: {
          tool: "task",
          state: {
            status: "error",
            input: { description: "Inspect failure" },
            error: detail,
          },
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "collab_agent_tool_call",
      status: "failed",
      detail,
      data: { kind: "task", description: "Inspect failure" },
    });
    expect(projectActivityPayload(projected)).toEqual(projected);
  });

  it("projects stored OpenCode TodoWrite input without serialized JSON", () => {
    const projected = projectActivityPayload({
      ...activity({
        itemType: "file_change",
        detail: '[{"content":"Test glob and grep","status":"completed","priority":"low"}]',
        data: {
          tool: "todowrite",
          state: {
            status: "completed",
            input: {
              todos: [
                { content: "Test glob and grep", status: "completed", priority: "low" },
                { content: "Test TodoWrite", status: "in_progress", priority: "high" },
                { content: "Review results", status: "pending", priority: "medium" },
                { content: "Cancelled task", status: "cancelled", priority: "medium" },
              ],
            },
          },
        },
      }),
      summary: "todowrite",
    });

    expect(projected.payload).toEqual({
      itemType: "file_change",
      data: {
        kind: "todo",
        todos: [
          { content: "Test glob and grep", status: "completed" },
          { content: "Test TodoWrite", status: "inProgress" },
          { content: "Review results", status: "pending" },
          { content: "Cancelled task", status: "cancelled" },
        ],
      },
    });
    expect(projectActivityPayload(projected)).toEqual(projected);
  });

  it("projects stored Claude TodoWrite input into the same todo shape", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        detail: "Todos updated",
        data: {
          toolName: "TodoWrite",
          input: {
            todos: [
              { content: "Check the surface", status: "in_progress", activeForm: "Checking" },
              { content: "Finish verification", status: "pending" },
            ],
          },
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "file_change",
      data: {
        kind: "todo",
        todos: [
          { content: "Check the surface", status: "inProgress" },
          { content: "Finish verification", status: "pending" },
        ],
      },
    });
  });

  it("preserves TodoWrite failure details", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        status: "failed",
        detail: "TodoWrite failed: provider disconnected",
        data: {
          tool: "todowrite",
          state: {
            input: { todos: [{ content: "Retry later", status: "pending" }] },
          },
        },
      }),
    );

    expect(projected.payload).toEqual({
      itemType: "file_change",
      status: "failed",
      detail: "TodoWrite failed: provider disconnected",
      data: {
        kind: "todo",
        todos: [{ content: "Retry later", status: "pending" }],
      },
    });
  });
});
