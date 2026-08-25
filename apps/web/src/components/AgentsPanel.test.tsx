import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AgentsPanel } from "./AgentsPanel";

const agent: RuntimeSubagent = {
  id: "child-session-1",
  kind: "subagent",
  title: "Inspect adapter",
  role: "explore",
  model: "openai/gpt-5",
  effort: null,
  status: "completed",
  activationCount: 1,
  usage: null,
  progress: null,
  lastToolName: "read",
  result: "Adapter inspected.",
  error: null,
  outputFile: null,
  parentAgentId: null,
  agentIndex: null,
  phaseIndex: null,
  phaseTitle: null,
  attempt: null,
  workflowName: null,
  phases: [],
  runHandles: null,
  recentActivity: [],
  firstSeenAt: "2026-08-25T12:00:00.000Z",
  startedAt: "2026-08-25T12:00:00.000Z",
  completedAt: "2026-08-25T12:00:01.000Z",
  updatedAt: "2026-08-25T12:00:01.000Z",
};

const model: AgentPanelModel = {
  workflows: [],
  directAgents: [agent],
  runningCount: 0,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 1,
  totalTokens: 0,
  hasAgents: true,
  liveCount: 0,
};

function render(provider: "opencode" | "codex") {
  return renderToStaticMarkup(
    <AgentsPanel
      model={model}
      environmentId={EnvironmentId.make("environment-1")}
      threadId={ThreadId.make("thread-1")}
      provider={ProviderDriverKind.make(provider)}
      cwd="/tmp/project"
    />,
  );
}

describe("AgentsPanel transcript inspection", () => {
  it("makes OpenCode subagents inspectable", () => {
    const html = render("opencode");

    expect(html).toContain('<button type="button"');
    expect(html).toContain("Inspect adapter");
    expect(html).toContain("Completed");
  });

  it("keeps unsupported provider rows non-interactive", () => {
    const html = render("codex");

    expect(html).not.toContain('<button type="button"');
    expect(html).toContain("Inspect adapter");
  });
});
