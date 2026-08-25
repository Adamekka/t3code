import type {
  EnvironmentId,
  ProviderTaskTranscriptMessage,
  ProviderTaskTranscriptPage,
  ProviderTaskTranscriptPart,
  ThreadId,
} from "@t3tools/contracts";
import { RuntimeTaskId } from "@t3tools/contracts";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { ArrowLeft, ChevronDown, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";

const TOOL_STATUS_LABELS: Record<
  Extract<ProviderTaskTranscriptPart, { type: "tool" }>["status"],
  string
> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

function TranscriptTool({ part }: { part: Extract<ProviderTaskTranscriptPart, { type: "tool" }> }) {
  return (
    <details className="group rounded-md border border-border/60 bg-muted/20">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-xs marker:hidden">
        <Wrench aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono">{part.name}</span>
        <span
          className={cn(
            "text-[.65rem]",
            part.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {TOOL_STATUS_LABELS[part.status]}
        </span>
        <ChevronDown
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="space-y-2 border-t border-border/50 p-2">
        {part.input !== undefined ? (
          <div>
            <p className="mb-1 text-[.65rem] font-medium uppercase tracking-wide text-muted-foreground">
              Input{part.inputTruncated ? " · truncated" : ""}
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed">
              {part.input}
            </pre>
          </div>
        ) : null}
        {part.output !== undefined || part.error !== undefined ? (
          <div>
            <p className="mb-1 text-[.65rem] font-medium uppercase tracking-wide text-muted-foreground">
              {part.error !== undefined ? "Error" : "Output"}
              {part.error !== undefined
                ? part.errorTruncated
                  ? " · truncated"
                  : ""
                : part.outputTruncated
                  ? " · truncated"
                  : ""}
            </p>
            <pre
              className={cn(
                "overflow-x-auto whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed",
                part.error !== undefined && "text-destructive-foreground",
              )}
            >
              {part.error ?? part.output}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function TranscriptPart({
  part,
  cwd,
  environmentId,
  threadId,
}: {
  part: ProviderTaskTranscriptPart;
  cwd: string | undefined;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  switch (part.type) {
    case "text":
      return (
        <div>
          <ChatMarkdown
            text={part.text}
            cwd={cwd}
            threadRef={{ environmentId, threadId }}
            lineBreaks
          />
          {part.truncated ? (
            <p className="mt-1 text-[.65rem] text-muted-foreground">Text truncated</p>
          ) : null}
        </div>
      );
    case "reasoning":
      return (
        <details className="group rounded-md border border-border/50 bg-muted/20">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground marker:hidden">
            <span className="flex-1">Thinking</span>
            <ChevronDown
              aria-hidden
              className="size-3 transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="border-t border-border/50 px-2 py-1.5 text-muted-foreground">
            <ChatMarkdown text={part.text} cwd={cwd} threadRef={{ environmentId, threadId }} />
            {part.truncated ? <p className="mt-1 text-[.65rem]">Reasoning truncated</p> : null}
          </div>
        </details>
      );
    case "tool":
      return <TranscriptTool part={part} />;
    case "notice":
      return (
        <div className="rounded-md border border-dashed border-border/60 px-2 py-1.5 text-xs text-muted-foreground">
          <p className="font-medium text-foreground/80">{part.label}</p>
          {part.detail ? <p className="mt-0.5">{part.detail}</p> : null}
        </div>
      );
  }
}

function TranscriptMessage({
  message,
  cwd,
  environmentId,
  threadId,
}: {
  message: ProviderTaskTranscriptMessage;
  cwd: string | undefined;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const createdAt = message.createdAt ? new Date(message.createdAt) : null;
  return (
    <article
      className={cn(
        "space-y-2 rounded-lg border p-2.5",
        message.role === "user"
          ? "border-border/70 bg-muted/35"
          : "border-transparent bg-background/40",
      )}
    >
      <header className="flex items-center justify-between text-[.65rem] font-medium uppercase tracking-wide text-muted-foreground">
        <span>{message.role === "user" ? "Prompt" : "Agent"}</span>
        {createdAt && !Number.isNaN(createdAt.valueOf()) ? (
          <time dateTime={message.createdAt} className="font-mono font-normal normal-case">
            {createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        ) : null}
      </header>
      {message.parts.length > 0 ? (
        <div className="space-y-2">
          {message.parts.map((part) => (
            <TranscriptPart
              key={part.id}
              part={part}
              cwd={cwd}
              environmentId={environmentId}
              threadId={threadId}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No displayable content</p>
      )}
    </article>
  );
}

export function AgentTranscript({
  agent,
  environmentId,
  threadId,
  cwd,
  statusLabel,
  onBack,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | undefined;
  statusLabel: string;
  onBack: () => void;
}) {
  const [requestedCursor, setRequestedCursor] = useState<string | null>(null);
  const [olderPages, setOlderPages] = useState<
    ReadonlyArray<{ readonly cursor: string; readonly page: ProviderTaskTranscriptPage }>
  >([]);
  const latestQuery = useEnvironmentQuery(
    orchestrationEnvironment.taskTranscript({
      environmentId,
      input: {
        threadId,
        taskId: RuntimeTaskId.make(agent.id),
        cursor: null,
      },
    }),
  );
  const olderQuery = useEnvironmentQuery(
    requestedCursor === null
      ? null
      : orchestrationEnvironment.taskTranscript({
          environmentId,
          input: {
            threadId,
            taskId: RuntimeTaskId.make(agent.id),
            cursor: requestedCursor,
          },
        }),
  );
  const previousUpdatedAt = useRef(agent.updatedAt);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const page = olderQuery.data;
    const cursor = requestedCursor;
    if (!page || cursor === null) {
      return;
    }
    setOlderPages((pages) =>
      pages.some((loaded) => loaded.cursor === cursor)
        ? pages
        : [
            ...pages,
            {
              cursor,
              page: page.nextCursor === cursor ? { ...page, nextCursor: null } : page,
            },
          ],
    );
    setRequestedCursor(null);
  }, [olderQuery.data, requestedCursor]);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (previousUpdatedAt.current === agent.updatedAt) {
      return;
    }
    previousUpdatedAt.current = agent.updatedAt;
    latestQuery.refresh();
  }, [agent.updatedAt, latestQuery.refresh]);

  const orderedPages = olderPages.map((loaded) => loaded.page).toReversed();
  if (latestQuery.data) {
    orderedPages.push(latestQuery.data);
  }
  const messageById = new Map<string, ProviderTaskTranscriptMessage>();
  for (const page of orderedPages) {
    for (const message of page.messages) {
      messageById.set(message.id, message);
    }
  }
  const messages = [...messageById.values()];
  const oldestPage = olderPages.at(-1)?.page ?? latestQuery.data;
  const errorMessage = latestQuery.error
    ? latestQuery.error.startsWith("This subagent transcript") ||
      latestQuery.error.startsWith("This provider does not support")
      ? latestQuery.error
      : "Couldn't load this agent's transcript."
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border/60 px-2 py-2">
        <div className="flex items-start gap-2">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost-muted"
            onClick={onBack}
            aria-label="Back to agents"
          >
            <ArrowLeft aria-hidden className="size-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h2 ref={titleRef} tabIndex={-1} className="truncate text-sm font-medium outline-none">
              {agent.title}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {[statusLabel, agent.role, agent.model].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-2">
          {oldestPage?.nextCursor ? (
            <Button
              type="button"
              size="sm"
              variant="ghost-muted"
              className="w-full"
              disabled={olderQuery.isPending}
              onClick={() => setRequestedCursor(oldestPage.nextCursor)}
            >
              {olderQuery.isPending ? "Loading earlier…" : "Load earlier"}
            </Button>
          ) : null}
          {latestQuery.isPending && messages.length === 0 ? (
            <p
              role="status"
              aria-live="polite"
              className="py-8 text-center text-xs text-muted-foreground"
            >
              Loading agent transcript…
            </p>
          ) : errorMessage && messages.length === 0 ? (
            <div role="alert" className="space-y-2 py-8 text-center">
              <p className="text-xs text-muted-foreground">{errorMessage}</p>
              <Button type="button" size="sm" variant="outline" onClick={latestQuery.refresh}>
                Retry
              </Button>
            </div>
          ) : messages.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No transcript is available for this agent.
            </p>
          ) : (
            messages.map((message) => (
              <TranscriptMessage
                key={message.id}
                message={message}
                cwd={cwd}
                environmentId={environmentId}
                threadId={threadId}
              />
            ))
          )}
          {(latestQuery.error || olderQuery.error) && messages.length > 0 ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 px-2 py-1.5"
            >
              <p className="text-xs text-destructive-foreground">
                {olderQuery.error
                  ? "Couldn't load earlier messages."
                  : "Couldn't refresh the transcript."}
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost-muted"
                onClick={olderQuery.error ? olderQuery.refresh : latestQuery.refresh}
              >
                Retry
              </Button>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
