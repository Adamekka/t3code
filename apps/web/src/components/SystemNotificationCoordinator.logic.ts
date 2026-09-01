import type { OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";

export type AgentSystemNotificationKind = "input" | "completed" | "failed" | "stopped";

export interface AgentSystemNotificationTransition {
  readonly id: string;
  readonly kind: AgentSystemNotificationKind;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
}

type NotificationThread = Pick<
  OrchestrationThreadShell,
  "id" | "title" | "session" | "latestTurn" | "updatedAt" | "hasPendingUserInput"
>;

interface ObservedNotificationState {
  readonly key: string;
  readonly id: string;
  readonly kind: AgentSystemNotificationKind | null;
  readonly active: boolean;
  readonly turnBasedTerminal: boolean;
}

const NEUTRAL_NOTIFICATION_STATE: ObservedNotificationState = {
  key: "neutral",
  id: "neutral",
  kind: null,
  active: false,
  turnBasedTerminal: false,
};

const ACTIVE_NOTIFICATION_STATE: ObservedNotificationState = {
  key: "active",
  id: "active",
  kind: null,
  active: true,
  turnBasedTerminal: false,
};

export interface AgentSystemNotificationController {
  update: (
    status: EnvironmentShellStatus,
    threads: ReadonlyArray<NotificationThread>,
  ) => ReadonlyArray<AgentSystemNotificationTransition>;
}

export function createAgentSystemNotificationController(): AgentSystemNotificationController {
  let live = false;
  let previousByThreadId = new Map<ThreadId, ObservedNotificationState>();

  function observe(thread: NotificationThread): ObservedNotificationState {
    const turnId = thread.latestTurn?.turnId ?? thread.session?.activeTurnId;
    if (thread.hasPendingUserInput) {
      return {
        // The shell exposes only a pending boolean, not the request ID. Keep
        // one semantic state while it stays true, but use the transition's
        // authoritative timestamp to distinguish a later question.
        key: "input",
        id: `input:${thread.updatedAt}`,
        kind: "input",
        active: false,
        turnBasedTerminal: false,
      };
    }

    if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
      return {
        key: `terminal:${turnId ?? thread.session?.updatedAt ?? thread.latestTurn?.completedAt}`,
        id: `terminal:${turnId ?? thread.session?.updatedAt ?? thread.latestTurn?.completedAt}`,
        kind: "failed",
        active: false,
        turnBasedTerminal: turnId !== null && turnId !== undefined,
      };
    }

    if (thread.session?.status === "starting" || thread.session?.status === "running") {
      return ACTIVE_NOTIFICATION_STATE;
    }
    if (thread.latestTurn?.state === "running") {
      return ACTIVE_NOTIFICATION_STATE;
    }

    if (thread.latestTurn?.state === "interrupted") {
      return {
        key: `terminal:${thread.latestTurn.turnId}`,
        id: `terminal:${thread.latestTurn.turnId}`,
        kind: "stopped",
        active: false,
        turnBasedTerminal: true,
      };
    }
    if (thread.latestTurn?.state === "completed") {
      return {
        key: `terminal:${thread.latestTurn.turnId}`,
        id: `terminal:${thread.latestTurn.turnId}`,
        kind: "completed",
        active: false,
        turnBasedTerminal: true,
      };
    }
    if (thread.session?.status === "stopped" || thread.session?.status === "interrupted") {
      return {
        key: `terminal:${thread.session.updatedAt}`,
        id: `terminal:${thread.session.updatedAt}`,
        kind: "stopped",
        active: false,
        turnBasedTerminal: false,
      };
    }
    if (thread.session?.status === "ready" || thread.session?.status === "idle") {
      return {
        key: `terminal:${thread.session.updatedAt}`,
        id: `terminal:${thread.session.updatedAt}`,
        kind: "completed",
        active: false,
        turnBasedTerminal: false,
      };
    }
    return NEUTRAL_NOTIFICATION_STATE;
  }

  return {
    update(status, threads) {
      if (status !== "live") {
        live = false;
        previousByThreadId = new Map();
        return [];
      }

      const nextByThreadId = new Map<ThreadId, ObservedNotificationState>();
      const transitions: AgentSystemNotificationTransition[] = [];
      for (const thread of threads) {
        const next = observe(thread);
        nextByThreadId.set(thread.id, next);
        const previous = previousByThreadId.get(thread.id);
        const enteredNotifiableState =
          previous !== undefined &&
          next.kind !== null &&
          previous.key !== next.key &&
          (next.kind === "input" ||
            next.turnBasedTerminal ||
            previous.active ||
            previous.kind === "input");
        if (live && enteredNotifiableState) {
          transitions.push({
            id: next.id,
            kind: next.kind,
            threadId: thread.id,
            threadTitle: thread.title,
          });
        }
      }

      live = true;
      previousByThreadId = nextByThreadId;
      return transitions;
    },
  };
}
