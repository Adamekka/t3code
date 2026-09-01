import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import { ensureLocalApi } from "../localApi";
import {
  createAgentSystemNotificationController,
  type AgentSystemNotificationKind,
  type AgentSystemNotificationTransition,
} from "./SystemNotificationCoordinator.logic";

const NOTIFICATION_TITLES: Readonly<Record<AgentSystemNotificationKind, string>> = {
  input: "Agent needs your input",
  completed: "Agent finished",
  failed: "Agent failed",
  stopped: "Agent stopped",
};

export function SystemNotificationCoordinator() {
  const { environments } = useEnvironments();
  const settingsHydrated = useClientSettingsHydrated();
  const notificationsEnabled = useClientSettings((settings) => settings.systemNotificationsEnabled);

  if (!settingsHydrated || !notificationsEnabled) {
    return null;
  }

  return environments.map((environment) => (
    <EnvironmentSystemNotificationObserver
      key={environment.environmentId}
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
    />
  ));
}

function EnvironmentSystemNotificationObserver({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const navigate = useNavigate();
  const [controller] = useState(() => createAgentSystemNotificationController());

  const deliver = useEffectEvent((transition: AgentSystemNotificationTransition) => {
    if (!("Notification" in window) || window.Notification.permission !== "granted") {
      return;
    }

    let notification: Notification;
    try {
      notification = new window.Notification(NOTIFICATION_TITLES[transition.kind], {
        body: `${environmentLabel}: ${transition.threadTitle}`,
        tag: `t3code:${environmentId}:${transition.threadId}:${transition.id}`,
      });
    } catch (error) {
      console.error("Could not show agent system notification.", error);
      return;
    }

    notification.addEventListener(
      "click",
      () => {
        notification.close();
        void (async () => {
          try {
            await ensureLocalApi().shell.revealWindow();
          } catch (error) {
            console.error("Could not reveal the app window.", error);
            window.focus();
          }
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams({
              environmentId,
              threadId: transition.threadId,
            }),
          });
        })().catch((error: unknown) => {
          console.error("Could not open the notification's thread.", error);
        });
      },
      { once: true },
    );
  });

  useEffect(() => {
    for (const transition of controller.update(shell.status, threads)) {
      deliver(transition);
    }
  }, [controller, shell.status, threads]);

  return null;
}
