import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createAgentSystemNotificationController,
  type AgentSystemNotificationController,
} from "./SystemNotificationCoordinator.logic";

const NOW = "2026-09-01T12:00:00.000Z";
const LATER = "2026-09-01T12:00:01.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");

type NotificationThread = Parameters<AgentSystemNotificationController["update"]>[1][number];

function thread(overrides: Partial<NotificationThread> = {}): NotificationThread {
  return {
    id: THREAD_ID,
    title: "Fix failing CI",
    session: null,
    latestTurn: null,
    updatedAt: NOW,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function session(
  status: NonNullable<NotificationThread["session"]>["status"],
  activeTurnId: TurnId | null,
  updatedAt = NOW,
): NonNullable<NotificationThread["session"]> {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "OpenCode",
    runtimeMode: "full-access",
    activeTurnId,
    lastError: status === "error" ? "Provider failed." : null,
    updatedAt,
  };
}

function turn(
  state: NonNullable<NotificationThread["latestTurn"]>["state"],
  turnId = TURN_ID,
): NonNullable<NotificationThread["latestTurn"]> {
  return {
    turnId,
    state,
    requestedAt: NOW,
    startedAt: NOW,
    completedAt: state === "running" ? null : LATER,
    assistantMessageId: null,
  };
}

describe("agent system notification transitions", () => {
  it("baselines initial live and reconnect snapshots without replaying them", () => {
    const controller = createAgentSystemNotificationController();
    const completed = thread({ latestTurn: turn("completed") });

    expect(controller.update("cached", [completed])).toEqual([]);
    expect(controller.update("synchronizing", [completed])).toEqual([]);
    expect(controller.update("live", [completed])).toEqual([]);
    expect(controller.update("cached", [completed])).toEqual([]);
    expect(controller.update("live", [completed])).toEqual([]);
  });

  it("notifies once when a thread starts waiting for input", () => {
    const controller = createAgentSystemNotificationController();
    const running = thread({ session: session("running", TURN_ID), latestTurn: turn("running") });
    const waiting = thread({
      session: session("running", TURN_ID, LATER),
      latestTurn: turn("running"),
      updatedAt: LATER,
      hasPendingUserInput: true,
    });

    expect(controller.update("live", [running])).toEqual([]);
    expect(controller.update("live", [waiting])).toEqual([
      {
        id: `input:${LATER}`,
        kind: "input",
        threadId: THREAD_ID,
        threadTitle: "Fix failing CI",
      },
    ]);
    expect(
      controller.update("live", [{ ...waiting, title: "A new title", updatedAt: NOW }]),
    ).toEqual([]);
    expect(controller.update("live", [running])).toEqual([]);
    expect(controller.update("live", [{ ...waiting, updatedAt: NOW }])).toMatchObject([
      { id: `input:${NOW}`, kind: "input" },
    ]);
  });

  it("prioritizes a question before notifying that the same turn completed", () => {
    const controller = createAgentSystemNotificationController();
    const running = thread({ session: session("running", TURN_ID), latestTurn: turn("running") });
    const completed = thread({
      session: session("ready", null, LATER),
      latestTurn: turn("completed"),
    });

    controller.update("live", [running]);
    expect(
      controller.update("live", [{ ...completed, hasPendingUserInput: true, updatedAt: LATER }]),
    ).toMatchObject([{ kind: "input" }]);
    expect(controller.update("live", [completed])).toMatchObject([{ kind: "completed" }]);
  });

  it("distinguishes completion, failure, and stopped turns without duplicate terminal alerts", () => {
    const controller = createAgentSystemNotificationController();
    const secondTurnId = TurnId.make("turn-2");
    const thirdTurnId = TurnId.make("turn-3");

    controller.update("live", [
      thread({ session: session("running", TURN_ID), latestTurn: turn("running") }),
    ]);
    expect(
      controller.update("live", [
        thread({ session: session("ready", null, LATER), latestTurn: turn("completed") }),
      ]),
    ).toMatchObject([{ kind: "completed" }]);
    expect(
      controller.update("live", [
        thread({ session: session("error", null, LATER), latestTurn: turn("error") }),
      ]),
    ).toEqual([]);

    controller.update("live", [
      thread({
        session: session("running", secondTurnId),
        latestTurn: turn("running", secondTurnId),
      }),
    ]);
    expect(
      controller.update("live", [
        thread({
          session: session("error", null, LATER),
          latestTurn: turn("error", secondTurnId),
        }),
      ]),
    ).toMatchObject([{ kind: "failed" }]);

    controller.update("live", [
      thread({
        session: session("running", thirdTurnId),
        latestTurn: turn("running", thirdTurnId),
      }),
    ]);
    expect(
      controller.update("live", [
        thread({
          session: session("ready", null, LATER),
          latestTurn: turn("interrupted", thirdTurnId),
        }),
      ]),
    ).toMatchObject([{ kind: "stopped" }]);
  });

  it("recognizes a settled session when no latest turn was materialized", () => {
    const controller = createAgentSystemNotificationController();

    controller.update("live", [thread({ session: session("running", TURN_ID) })]);
    expect(
      controller.update("live", [thread({ session: session("ready", null, LATER) })]),
    ).toMatchObject([{ id: `terminal:${LATER}`, kind: "completed" }]);
  });

  it("recognizes a failed session when no latest turn was materialized", () => {
    const controller = createAgentSystemNotificationController();

    controller.update("live", [thread({ session: session("running", TURN_ID) })]);
    expect(
      controller.update("live", [thread({ session: session("error", null, LATER) })]),
    ).toMatchObject([{ id: `terminal:${LATER}`, kind: "failed" }]);
  });

  it("does not treat an idle provider session exit as a stopped turn", () => {
    const controller = createAgentSystemNotificationController();

    controller.update("live", [thread({ session: session("ready", null) })]);
    expect(
      controller.update("live", [thread({ session: session("stopped", null, LATER) })]),
    ).toEqual([]);
  });

  it("baselines a newly observed thread instead of guessing that its old state is new", () => {
    const controller = createAgentSystemNotificationController();

    controller.update("live", []);
    expect(controller.update("live", [thread({ latestTurn: turn("completed") })])).toEqual([]);
  });
});
