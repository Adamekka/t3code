import {
  EventId,
  type OpenCodeSettings,
  PROVIDER_TASK_TRANSCRIPT_PAGE_SIZE,
  PROVIDER_TASK_TRANSCRIPT_PART_MAX_CHARS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderTaskTranscriptError,
  type ProviderTaskTranscriptMessage,
  type ProviderTaskTranscriptPart,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { OpencodeClient, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  parseOpenCodeGrepOutput,
  parseOpenCodeReadOutput,
  parseOpenCodeTaskEnvelope,
} from "../OpenCodeToolOutput.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import * as Option from "effect/Option";

const PROVIDER = ProviderDriverKind.make("opencode");
const isProviderTaskTranscriptError = Schema.is(ProviderTaskTranscriptError);

/**
 * Version tag stamped into the OpenCode resume cursor. Bump if the cursor
 * shape changes so stale-shaped cursors written by older builds are ignored
 * rather than misread (mirrors GROK_RESUME_VERSION / CURSOR_RESUME_VERSION).
 */
const OPENCODE_RESUME_VERSION = 1 as const;
// Task results are also retained on the parent tool row; cap the duplicate agent summary on the wire.
const MAX_TASK_COMPLETION_SUMMARY_LENGTH = 4_000;

/**
 * Decode a persisted resume cursor into the upstream `ses_…` id. Anything
 * that isn't a current-version cursor with a non-empty id means "no resume"
 * rather than an error. Re-adopting the session id IS the resume mechanism —
 * OpenCode scopes a conversation's history by session id.
 */
function parseOpenCodeResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== OPENCODE_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

/**
 * Whether an error definitively reports a missing session. Only a confirmed
 * miss may silently start a fresh session; any other failure (the SDK client
 * is `throwOnError: true`, so `session.get` rejects on every non-2xx) must
 * propagate, or a transient blip resets a live thread to an empty one — the
 * #3604 silent context loss. Decides on structured signals only, never free
 * text: a numeric 404 or the exact `NotFoundError` name, found via a bounded walk
 * over `cause`/`body`/`error`/`data`. An explicit non-404 status seals its
 * subtree so a wrapped "NotFound" name can't reclassify a real failure.
 * Exported for unit testing.
 */
export function isOpenCodeNotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const record = node as Record<string, unknown>;

    const response = record.response;
    const statuses = [
      record.status,
      record.statusCode,
      response !== null && typeof response === "object"
        ? (response as { readonly status?: unknown }).status
        : undefined,
    ].filter((status): status is number => typeof status === "number");
    if (statuses.includes(404)) {
      return true;
    }
    if (statuses.length > 0) {
      continue;
    }

    const name = record.name;
    if (typeof name === "string" && name.toLowerCase() === "notfounderror") {
      return true;
    }

    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }
  return false;
}

/**
 * Whether two directory spellings name the same location. Raw string
 * equality misreads a trailing slash, `.`/`..` segment, or symlinked cwd
 * (macOS `/tmp` → `/private/tmp`) as a cwd change, needlessly forking the
 * session on every resume. Lexically equal paths short-circuit; otherwise
 * both sides go through `realPath`, each falling back to its lexical form
 * on failure (deleted directory, external-server path) — so the probe can
 * only widen matches, never split them. Takes the services as arguments so
 * adapter methods stay service-free. Exported for unit testing.
 */
export function isSameOpenCodeDirectory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
): Effect.Effect<boolean> {
  const lexicalLeft = path.resolve(left);
  const lexicalRight = path.resolve(right);
  if (lexicalLeft === lexicalRight) {
    return Effect.succeed(true);
  }
  const canonicalize = (lexical: string) =>
    fileSystem.realPath(lexical).pipe(Effect.orElseSucceed(() => lexical));
  return Effect.zipWith(
    canonicalize(lexicalLeft),
    canonicalize(lexicalRight),
    (canonicalLeft, canonicalRight) => canonicalLeft === canonicalRight,
  );
}

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface OpenCodeTaskActivation {
  readonly taskId: string;
  readonly callId: string;
  readonly turnId: TurnId | undefined;
  readonly description: string | undefined;
  readonly role: string | undefined;
  readonly model: string | undefined;
  readonly background: boolean;
  readonly resumed: boolean;
  lifecycleEmitted: boolean;
  terminal: boolean;
  candidateError: string | undefined;
  candidateStopped: boolean;
}

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

type OpenCodeSessionStatusEvent = Extract<
  OpenCodeSubscribedEvent,
  { readonly type: "session.status" }
>;

const OpenCodeSessionStatusMap = Schema.Record(
  Schema.String,
  Schema.Struct({ type: Schema.String }),
);
const decodeOpenCodeSessionStatusMap = Schema.decodeUnknownOption(OpenCodeSessionStatusMap);

const OpenCodeTodoList = Schema.Array(
  Schema.Struct({
    content: TrimmedNonEmptyString,
    status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
  }),
);
const decodeOpenCodeTodoList = Schema.decodeUnknownOption(OpenCodeTodoList);
type OpenCodePlan = Extract<
  ProviderRuntimeEvent,
  { readonly type: "turn.plan.updated" }
>["payload"]["plan"];

function parseOpenCodePlan(input: unknown): OpenCodePlan | null {
  const decoded = Option.getOrNull(decodeOpenCodeTodoList(input));
  if (decoded === null) {
    return null;
  }

  const plan: Array<OpenCodePlan[number]> = [];
  for (const todo of decoded) {
    // OpenCode retains cancelled todos in session state, but they are no longer
    // plan work and the shared runtime contract has no cancelled step status.
    if (todo.status === "cancelled") {
      continue;
    }
    plan.push({
      step: todo.content,
      status:
        todo.status === "pending"
          ? "pending"
          : todo.status === "in_progress"
            ? "inProgress"
            : "completed",
    });
  }
  return plan;
}

interface OpenCodeCancellation {
  readonly turnId: TurnId | undefined;
  readonly acknowledgment: Deferred.Deferred<void>;
  readonly completion: Deferred.Deferred<void, ProviderAdapterRequestError>;
  acknowledged?: boolean;
  turnSettled?: boolean;
  deferredIdleEvent?: OpenCodeSessionStatusEvent;
}

interface OpenCodeIdleReconciliation {
  readonly turnId: TurnId;
  readonly promptGeneration: number;
  raw: unknown;
  warned: boolean;
  dirty: boolean;
  fiber?: Fiber.Fiber<void, never>;
}

interface OpenCodePromptAdmission {
  readonly generation: number;
  readonly turnId: TurnId;
  readonly messageId: string;
  readonly priorAwaitingBusy: boolean;
  readonly priorIdle: { readonly turnId: TurnId; readonly raw: unknown } | undefined;
  idleDuringAdmission: { readonly turnId: TurnId; readonly raw: unknown } | undefined;
  idleObservedAfterMessage: boolean;
  messageObserved: boolean;
  busyObserved: boolean;
  idleStatusConfirmations: number;
  accepted: boolean;
  cancelled: boolean;
  readonly acceptance: Deferred.Deferred<void>;
  readonly submissionSettled: Deferred.Deferred<void>;
  promptFiber?: Fiber.Fiber<void, ProviderAdapterRequestError>;
  recoveryFiber?: Fiber.Fiber<void, never>;
  recoveryRaw: unknown;
}

type OpenCodeTerminalRequestEvent = Extract<
  OpenCodeSubscribedEvent,
  {
    readonly type: "permission.replied" | "question.replied" | "question.rejected";
  }
>;

type OpenCodeAskedRequestEvent = Extract<
  OpenCodeSubscribedEvent,
  { readonly type: "permission.asked" | "question.asked" }
>;

type OpenCodeRoutedRequestEvent = OpenCodeAskedRequestEvent | OpenCodeTerminalRequestEvent;

interface OpenCodeRequestRelationRetry {
  warned: boolean;
  fiber?: Fiber.Fiber<void, never>;
}

interface OpenCodePendingRequestRecovery {
  warned: boolean;
  rerun: boolean;
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function taskStateMetadata(part: Part | undefined): Record<string, unknown> | undefined {
  if (part?.type !== "tool" || part.state.status === "pending") {
    return undefined;
  }
  const metadata = part.state.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : undefined;
}

function taskInputString(part: Extract<Part, { readonly type: "tool" }>, key: string) {
  const value = part.state.input[key];
  return typeof value === "string" ? trimText(value) : undefined;
}

function taskModel(metadata: Record<string, unknown> | undefined): string | undefined {
  const value = metadata?.model;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const model = value as Record<string, unknown>;
  const providerId = typeof model.providerID === "string" ? trimText(model.providerID) : undefined;
  const modelId = typeof model.modelID === "string" ? trimText(model.modelID) : undefined;
  return providerId && modelId ? `${providerId}/${modelId}` : undefined;
}

function openCodeEventSessionId(event: OpenCodeSubscribedEvent): string | undefined {
  const properties = "properties" in event ? event.properties : undefined;
  if (!properties || typeof properties !== "object") {
    return undefined;
  }

  const sessionID = (properties as { readonly sessionID?: unknown }).sessionID;
  const sessionIDFromProperties = typeof sessionID === "string" ? sessionID : undefined;
  if (sessionIDFromProperties) {
    return sessionIDFromProperties;
  }

  const info = (properties as { readonly info?: { readonly id?: unknown } }).info;
  return info && typeof info.id === "string" ? info.id : undefined;
}

function openCodeEventSessionTitle(event: OpenCodeSubscribedEvent): string | undefined {
  if (event.type !== "session.updated") {
    return undefined;
  }

  const title = trimText(event.properties.info.title);
  // OpenCode mints a placeholder title at session.create when no title was
  // provided, and re-emits it on every `session.updated`. Mirroring it would
  // overwrite the thread's real title (openCodeEventSessionTitle feeds the
  // `thread.metadata.updated` mirror). Ignore OpenCode's auto-generated
  // placeholders so the thread isn't locked onto them.
  if (!title || isOpenCodeDefaultTitle(title)) {
    return undefined;
  }

  return title;
}

function isOpenCodeAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "MessageAbortedError"
  );
}

function isOpenCodeChildRequestEvent(event: OpenCodeSubscribedEvent): boolean {
  switch (event.type) {
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      return true;
    default:
      return false;
  }
}

const OPENCODE_DEFAULT_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isOpenCodeDefaultTitle(title: string): boolean {
  return OPENCODE_DEFAULT_TITLE_PATTERN.test(title);
}

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly relatedSessionIds: Set<string>;
  readonly resolvedRequestIds: Set<string>;
  readonly emittedTerminalRequestIds: Set<string>;
  readonly requestRelationRetries: Map<string, OpenCodeRequestRelationRetry>;
  readonly modelContextLimitBySlug: ReadonlyMap<string, number>;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly partById: Map<string, Part>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly taskActivationsByCallId: Map<string, OpenCodeTaskActivation>;
  readonly taskActivationByChildSessionId: Map<string, OpenCodeTaskActivation>;
  readonly reportedChildToolCallIds: Set<string>;
  reconcilingTasks: boolean;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  lastEmittedPlan: { readonly turnId: TurnId | undefined; readonly plan: OpenCodePlan } | undefined;
  activeTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  cancellation: OpenCodeCancellation | undefined;
  interruptedTurnId: TurnId | undefined;
  reconcileIdleStatus: boolean;
  awaitingBusyAfterInterruption: boolean;
  pendingIdleReconciliation: OpenCodeIdleReconciliation | undefined;
  pendingRequestRecovery: OpenCodePendingRequestRecovery | undefined;
  promptGeneration: number;
  promptAdmission: OpenCodePromptAdmission | undefined;
  readonly promptSemaphore: Semaphore.Semaphore;
  readonly firstConnection: Deferred.Deferred<void, ProviderAdapterRequestError>;
  /**
   * One-shot guard flipped by `stopOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` fetch),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
}

function recordOpenCodePlan(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  plan: OpenCodePlan,
): boolean {
  const previous = context.lastEmittedPlan;
  if (
    previous !== undefined &&
    previous.turnId === turnId &&
    previous.plan.length === plan.length &&
    plan.every(
      (step, index) =>
        step.step === previous.plan[index]?.step && step.status === previous.plan[index]?.status,
    )
  ) {
    return false;
  }
  context.lastEmittedPlan = { turnId, plan };
  return true;
}

export interface OpenCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
};

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

const ensureSessionContext = Effect.fn("ensureSessionContext")(function* (
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
) {
  const session = sessions.get(threadId);
  if (!session) {
    return yield* new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (yield* Ref.get(session.stopped)) {
    return yield* new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
});

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  const previous = previousText ?? "";
  const prefixLength = latestText.startsWith(previous)
    ? previous.length
    : commonPrefixLength(previous, latestText);
  return {
    latestText,
    deltaToEmit: latestText.slice(prefixLength),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  return {
    nextText: previousText + delta,
    deltaToEmit: delta,
  };
}

const isoFromEpochMs = (value: number) =>
  DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function toolStateStartedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  return part.state.status === "pending" ? undefined : isoFromEpochMs(part.state.time.start);
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    return applyProviderSessionUpdate(context, patch, options, yield* nowIso);
  });
}

function applyProviderSessionUpdate(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options:
    | {
        readonly clearActiveTurnId?: boolean;
        readonly clearLastError?: boolean;
      }
    | undefined,
  updatedAt: string,
): ProviderSession {
  const nextSession = {
    ...context.session,
    ...patch,
    updatedAt,
  } as ProviderSession & Record<string, unknown>;
  const mutableSession = nextSession as Record<string, unknown>;
  if (options?.clearActiveTurnId) {
    delete mutableSession.activeTurnId;
  }
  if (options?.clearLastError) {
    delete mutableSession.lastError;
  }
  context.session = nextSession;
  return nextSession;
}

const failPendingOpenCodeCancellation = Effect.fn("failPendingOpenCodeCancellation")(function* (
  context: OpenCodeSessionContext,
  detail: string,
) {
  const cancellation = context.cancellation;
  if (!cancellation) {
    return;
  }
  context.cancellation = undefined;
  yield* Deferred.fail(
    cancellation.completion,
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session.abort",
      detail,
    }),
  ).pipe(Effect.ignore);
});

const abortOpenCodeDescendants = Effect.fn("abortOpenCodeDescendants")(function* (
  context: OpenCodeSessionContext,
) {
  const visited = new Set([context.openCodeSessionId]);
  const requestSemaphore = Semaphore.makeUnsafe(8);

  const visit = (
    sessionId: string,
    abortSession: boolean,
  ): Effect.Effect<OpenCodeRuntimeError | undefined> =>
    Effect.gen(function* () {
      let firstFailure: OpenCodeRuntimeError | undefined;
      if (abortSession) {
        const abortResult = yield* requestSemaphore
          .withPermit(
            runOpenCodeSdk("session.abort", (signal) =>
              context.client.session.abort({ sessionID: sessionId }, { signal }),
            ),
          )
          .pipe(
            Effect.catchIf(
              (cause) => isOpenCodeNotFound(cause),
              () => Effect.void,
            ),
            Effect.result,
          );
        if (abortResult._tag === "Failure") {
          firstFailure = abortResult.failure;
        }
      }

      const childrenResult = yield* requestSemaphore
        .withPermit(
          runOpenCodeSdk("session.children", (signal) =>
            context.client.session.children({ sessionID: sessionId }, { signal }),
          ),
        )
        .pipe(
          Effect.catchIf(
            (cause) => isOpenCodeNotFound(cause),
            () => Effect.void,
          ),
          Effect.result,
        );
      if (childrenResult._tag === "Failure") {
        return firstFailure ?? childrenResult.failure;
      }

      const children = childrenResult.success?.data ?? [];
      const newChildren = children.filter((child) => {
        if (visited.has(child.id)) {
          return false;
        }
        visited.add(child.id);
        return true;
      });
      const childFailures = yield* Effect.forEach(newChildren, (child) => visit(child.id, true), {
        concurrency: 8,
      });
      firstFailure ??= childFailures.find((failure) => failure !== undefined);
      return firstFailure;
    });

  const firstFailure = yield* visit(context.openCodeSessionId, false);
  if (firstFailure) {
    return yield* firstFailure;
  }
});

const abortOpenCodeSessionForTeardown = Effect.fn("abortOpenCodeSessionForTeardown")(function* (
  context: OpenCodeSessionContext,
) {
  // Stop the parent before the snapshot so it cannot add another child after
  // the adapter reads the tree.
  yield* runOpenCodeSdk("session.abort", (signal) =>
    context.client.session.abort({ sessionID: context.openCodeSessionId }, { signal }),
  ).pipe(Effect.timeout("1 second"), Effect.ignore({ log: true }));
  yield* abortOpenCodeDescendants(context).pipe(
    Effect.timeout("1 second"),
    Effect.ignore({ log: true }),
  );
});

const cancelPendingOpenCodePrompt = Effect.fn("cancelPendingOpenCodePrompt")(function* (
  context: OpenCodeSessionContext,
) {
  const admission = context.promptAdmission;
  if (!admission) {
    return;
  }
  admission.cancelled = true;
  if (admission.promptFiber) {
    yield* Fiber.interrupt(admission.promptFiber);
  }
  yield* Deferred.await(admission.submissionSettled);
});

const closeStartingOpenCodeContext = Effect.fn("closeStartingOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
  abortRemote: boolean,
) {
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return;
  }
  yield* Deferred.fail(
    context.firstConnection,
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "event.subscribe",
      detail: "OpenCode session startup ended before the event stream connected.",
    }),
  ).pipe(Effect.ignore);
  yield* cancelPendingOpenCodePrompt(context);
  yield* failPendingOpenCodeCancellation(context, "OpenCode session startup was cancelled.");
  context.promptAdmission = undefined;
  if (abortRemote) {
    yield* abortOpenCodeSessionForTeardown(context);
  }
  yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
});

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }
  yield* Deferred.fail(
    context.firstConnection,
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "event.subscribe",
      detail: "OpenCode session stopped before the event stream connected.",
    }),
  ).pipe(Effect.ignore);
  yield* cancelPendingOpenCodePrompt(context);
  const cancellation = context.cancellation;
  context.cancellation = undefined;
  if (cancellation) {
    yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
  }
  context.promptAdmission = undefined;

  // Best-effort remote abort. The scope close below tears down the local
  // handles (event-pump fiber, server-exit fiber, event-subscribe fetch),
  // but we still want to tell OpenCode that this session is done.
  yield* abortOpenCodeSessionForTeardown(context);

  // Closing the session scope interrupts every fiber forked into it and
  // runs each finalizer we registered — the `AbortController.abort()` call,
  // the child-process termination, etc.
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sameDirectory = (left: string, right: string) =>
      isSameOpenCodeDirectory(fileSystem, path, left, right);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();
    const sessionSequenceByThreadId = new Map<ThreadId, number>();
    const deleteContextIfCurrent = (context: OpenCodeSessionContext) => {
      if (sessions.get(context.session.threadId) === context) {
        sessions.delete(context.session.threadId);
      }
    };
    const deleteSessionSequenceIfInactive = (threadId: ThreadId) => {
      if (!sessions.has(threadId)) {
        sessionSequenceByThreadId.delete(threadId);
      }
    };
    const awaitOpenCodeContextReady = Effect.fn("awaitOpenCodeContextReady")(function* (
      context: OpenCodeSessionContext,
    ) {
      yield* Deferred.await(context.firstConnection);
      const current = yield* ensureSessionContext(sessions, context.session.threadId);
      if (current !== context) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.session.threadId,
        });
      }
      return current;
    });
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode runtime identifier.",
            cause,
          }),
      ),
    );
    let messageIdEpochMillis = -1;
    let messageIdCounter = 0;
    // T3 supplies the message ID to match prompt admission events. Keep OpenCode's sortable native shape so equal-time messages retain their upstream order.
    const makeOpenCodeMessageId = Effect.fn("makeOpenCodeMessageId")(function* () {
      const epochMillis = DateTime.toEpochMillis(yield* DateTime.now);
      if (epochMillis !== messageIdEpochMillis) {
        messageIdEpochMillis = epochMillis;
        messageIdCounter = 0;
      }
      messageIdCounter += 1;
      const encodedTime = BigInt.asUintN(
        48,
        BigInt(epochMillis) * 0x1000n + BigInt(messageIdCounter),
      )
        .toString(16)
        .padStart(12, "0");
      const randomBytes = yield* crypto.randomBytes(14).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "crypto/randomBytes",
              detail: "Failed to generate an OpenCode message identifier.",
              cause,
            }),
        ),
      );
      const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
      const random = Array.from(randomBytes, (byte) => alphabet[byte % alphabet.length]).join("");
      return `msg_${encodedTime}${random}`;
    });
    const nextSessionSequence = (threadId: ThreadId, observedAt: string) => {
      // Millisecond timestamps can tie; microsecond slots preserve adapter delivery order.
      const observedSequence = Date.parse(observedAt) * 1_000;
      const previous = sessionSequenceByThreadId.get(threadId);
      const sequence =
        previous === undefined ? observedSequence : Math.max(previous + 1, observedSequence);
      sessionSequenceByThreadId.set(threadId, sequence);
      return sequence;
    };
    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
        observedAt: nowIso,
      }).pipe(
        Effect.map(({ eventId, createdAt, observedAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          sessionSequence: nextSessionSequence(input.threadId, observedAt),
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `ignoreCause` swallows both typed failures (none here) and defects
        // from throwing scope finalizers so a sibling's death can't interrupt
        // the remaining cleanups.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        sessionSequenceByThreadId.clear();
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const taskLinkage = (activation: OpenCodeTaskActivation) => ({
      taskType: "subagent" as const,
      ...(activation.description
        ? { description: activation.description, title: activation.description }
        : {}),
      ...(activation.role ? { role: activation.role } : {}),
      ...(activation.model ? { model: activation.model } : {}),
      toolUseId: activation.callId,
    });
    const taskEventBase = (
      context: OpenCodeSessionContext,
      activation: OpenCodeTaskActivation,
      phase: string,
      createdAt?: string,
    ) =>
      Effect.all({
        createdAt: createdAt === undefined ? nowIso : Effect.succeed(createdAt),
        observedAt: nowIso,
      }).pipe(
        Effect.map(({ createdAt: at, observedAt }) => ({
          eventId: EventId.make(
            `opencode-task:${boundInstanceId}:${context.session.threadId}:${context.openCodeSessionId}:${activation.callId}:${context.reconcilingTasks ? "reconciled:" : ""}${phase}`,
          ),
          provider: PROVIDER,
          threadId: context.session.threadId,
          createdAt: at,
          ...(context.reconcilingTasks
            ? {}
            : { sessionSequence: nextSessionSequence(context.session.threadId, observedAt) }),
          ...(activation.turnId ? { turnId: activation.turnId } : {}),
        })),
      );
    const emitTaskActivation = Effect.fn("emitOpenCodeTaskActivation")(function* (
      context: OpenCodeSessionContext,
      activation: OpenCodeTaskActivation,
      createdAt?: string,
    ) {
      if (activation.lifecycleEmitted || activation.terminal) {
        return;
      }
      activation.lifecycleEmitted = true;
      if (activation.resumed) {
        yield* emit({
          ...(yield* taskEventBase(context, activation, "running", createdAt)),
          type: "task.updated",
          payload: {
            taskId: RuntimeTaskId.make(activation.taskId),
            status: "running",
            ...taskLinkage(activation),
          },
        });
        return;
      }
      yield* emit({
        ...(yield* taskEventBase(context, activation, "started", createdAt)),
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.make(activation.taskId),
          ...taskLinkage(activation),
        },
      });
    });
    const completeTaskActivation = Effect.fn("completeOpenCodeTaskActivation")(function* (
      context: OpenCodeSessionContext,
      activation: OpenCodeTaskActivation,
      status: "completed" | "failed" | "stopped",
      summary?: string,
      createdAt?: string,
    ) {
      if (activation.terminal) {
        return;
      }
      yield* emitTaskActivation(context, activation, createdAt);
      activation.terminal = true;
      const normalizedSummary = trimText(summary);
      const boundedSummary =
        normalizedSummary && normalizedSummary.length > MAX_TASK_COMPLETION_SUMMARY_LENGTH
          ? `${normalizedSummary.slice(0, MAX_TASK_COMPLETION_SUMMARY_LENGTH - 3).trimEnd()}...`
          : normalizedSummary;
      yield* emit({
        ...(yield* taskEventBase(context, activation, "terminal", createdAt)),
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make(activation.taskId),
          status,
          ...(boundedSummary ? { summary: boundedSummary } : {}),
          ...taskLinkage(activation),
        },
      });
    });
    const emitTaskStatus = Effect.fn("emitOpenCodeTaskStatus")(function* (
      context: OpenCodeSessionContext,
      activation: OpenCodeTaskActivation,
      status: "running" | "waiting" | "idle",
      raw: unknown,
    ) {
      if (activation.terminal) {
        return;
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: activation.turnId,
          raw,
        })),
        type: "task.updated",
        payload: {
          taskId: RuntimeTaskId.make(activation.taskId),
          status,
          ...taskLinkage(activation),
        },
      });
    });
    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const cancelIdleReconciliation = Effect.fn("cancelIdleReconciliation")(function* (
      context: OpenCodeSessionContext,
    ) {
      const pending = context.pendingIdleReconciliation;
      context.pendingIdleReconciliation = undefined;
      if (pending?.fiber) {
        yield* Fiber.interrupt(pending.fiber);
      }
    });

    const completeOpenCodeTurn = Effect.fn("completeOpenCodeTurn")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      promptGeneration: number,
      raw: unknown,
    ) {
      const updatedAt = yield* nowIso;
      const stopped = yield* Ref.get(context.stopped);
      if (
        stopped ||
        context.activeTurnId !== turnId ||
        context.promptGeneration !== promptGeneration ||
        context.cancellation?.turnId === turnId
      ) {
        return;
      }
      const pendingIdleReconciliation = context.pendingIdleReconciliation;
      if (
        pendingIdleReconciliation?.turnId === turnId &&
        pendingIdleReconciliation.promptGeneration === promptGeneration
      ) {
        context.pendingIdleReconciliation = undefined;
      }
      context.activeTurnId = undefined;
      context.activeAgent = undefined;
      context.activeVariant = undefined;
      context.interruptedTurnId = undefined;
      context.awaitingBusyAfterInterruption = false;
      context.reconcileIdleStatus = false;
      applyProviderSessionUpdate(
        context,
        { status: "ready" },
        { clearActiveTurnId: true },
        updatedAt,
      );
      if (pendingIdleReconciliation?.fiber) {
        yield* Fiber.interrupt(pendingIdleReconciliation.fiber);
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          raw,
        })),
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
    });

    const scheduleIdleReconciliation = Effect.fn("scheduleIdleReconciliation")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      raw: unknown,
    ) {
      const existing = context.pendingIdleReconciliation;
      if (existing?.turnId === turnId && existing.promptGeneration === context.promptGeneration) {
        existing.raw = raw;
        existing.dirty = true;
        return;
      }
      yield* cancelIdleReconciliation(context);

      const pending: OpenCodeIdleReconciliation = {
        turnId,
        promptGeneration: context.promptGeneration,
        raw,
        warned: false,
        dirty: false,
      };
      context.pendingIdleReconciliation = pending;
      const reconcile = Effect.gen(function* () {
        let retryCount = 0;
        while (context.pendingIdleReconciliation === pending) {
          if (
            context.activeTurnId !== turnId ||
            context.awaitingBusyAfterInterruption ||
            context.promptGeneration !== pending.promptGeneration
          ) {
            context.pendingIdleReconciliation = undefined;
            return;
          }
          const result = yield* runOpenCodeSdk("session.status", (signal) =>
            context.client.session.status(undefined, { signal }),
          ).pipe(
            Effect.timeout("1 second"),
            Effect.retry({ times: 1 }),
            Effect.match({
              onFailure: (cause) => ({ type: "unknown" as const, cause }),
              onSuccess: (response) => {
                const data = Option.getOrUndefined(decodeOpenCodeSessionStatusMap(response.data));
                if (data === undefined) {
                  return { type: "unknown" as const, cause: undefined };
                }
                const status = data[context.openCodeSessionId];
                if (status === undefined || status.type === "idle") {
                  return { type: "idle" as const };
                }
                if (status.type === "busy" || status.type === "retry") {
                  return { type: "busy" as const };
                }
                return { type: "unknown" as const, cause: undefined };
              },
            }),
          );

          if (
            context.pendingIdleReconciliation !== pending ||
            context.activeTurnId !== turnId ||
            context.promptGeneration !== pending.promptGeneration
          ) {
            return;
          }
          if (result.type === "idle") {
            context.pendingIdleReconciliation = undefined;
            yield* completeOpenCodeTurn(context, turnId, pending.promptGeneration, pending.raw);
            return;
          }
          if (result.type === "busy") {
            if (pending.dirty) {
              pending.dirty = false;
              continue;
            }
            context.pendingIdleReconciliation = undefined;
            return;
          }
          if (!pending.warned) {
            pending.warned = true;
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode turn completion is waiting for session status.",
                detail:
                  result.cause === undefined
                    ? "session.status returned missing or invalid status data."
                    : openCodeRuntimeErrorDetail(result.cause),
              },
            });
          }
          const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
          retryCount += 1;
          yield* Effect.sleep(`${delayMs} millis`);
        }
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (context.pendingIdleReconciliation === pending) {
              context.pendingIdleReconciliation = undefined;
            }
          }),
        ),
      );
      pending.fiber = yield* reconcile.pipe(Effect.forkIn(context.sessionScope));
    });

    const failPromptAdmissionRecovery = Effect.fn("failPromptAdmissionRecovery")(function* (
      context: OpenCodeSessionContext,
      promptAdmission: OpenCodePromptAdmission,
    ) {
      if (
        context.promptAdmission !== promptAdmission ||
        context.activeTurnId !== promptAdmission.turnId ||
        context.promptGeneration !== promptAdmission.generation
      ) {
        return;
      }
      const detail =
        "OpenCode accepted the prompt, but T3 Code could not confirm its message or session status.";
      const abortExit = yield* Effect.exit(
        runOpenCodeSdk("session.abort", (signal) =>
          context.client.session.abort({ sessionID: context.openCodeSessionId }, { signal }),
        ).pipe(Effect.timeout("1 second")),
      );
      if (Exit.isFailure(abortExit)) {
        yield* emitUnexpectedExit(
          context,
          `${detail} The cleanup abort also failed: ${openCodeRuntimeErrorDetail(Cause.squash(abortExit.cause))}`,
        );
        deleteContextIfCurrent(context);
        return;
      }
      context.promptAdmission = undefined;
      context.activeTurnId = undefined;
      context.activeAgent = undefined;
      context.activeVariant = undefined;
      context.awaitingBusyAfterInterruption = false;
      context.reconcileIdleStatus = false;
      yield* updateProviderSession(
        context,
        { status: "error", lastError: detail },
        { clearActiveTurnId: true },
      );
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: promptAdmission.turnId,
          raw: promptAdmission.recoveryRaw,
        })),
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: detail,
        },
      });
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: promptAdmission.turnId,
          raw: promptAdmission.recoveryRaw,
        })),
        type: "runtime.error",
        payload: {
          message: detail,
          class: "transport_error",
        },
      });
    });

    const schedulePromptAdmissionRecovery = Effect.fn("schedulePromptAdmissionRecovery")(function* (
      context: OpenCodeSessionContext,
      raw: unknown,
    ) {
      const promptAdmission = context.promptAdmission;
      if (!promptAdmission || promptAdmission.cancelled) {
        return;
      }
      if (raw !== undefined) {
        promptAdmission.recoveryRaw = raw;
      }
      if (promptAdmission.recoveryFiber) {
        return;
      }
      const recover = Effect.gen(function* () {
        yield* Deferred.await(promptAdmission.acceptance);
        for (let retryCount = 0; retryCount < 5; retryCount += 1) {
          if (
            context.promptAdmission !== promptAdmission ||
            context.activeTurnId !== promptAdmission.turnId ||
            context.promptGeneration !== promptAdmission.generation ||
            promptAdmission.cancelled ||
            (yield* Ref.get(context.stopped))
          ) {
            return;
          }

          if (!promptAdmission.messageObserved) {
            const response = yield* runOpenCodeSdk("session.message", (signal) =>
              context.client.session.message(
                {
                  sessionID: context.openCodeSessionId,
                  messageID: promptAdmission.messageId,
                },
                { signal },
              ),
            ).pipe(Effect.timeout("1 second"), Effect.option);
            const stopped = yield* Ref.get(context.stopped);
            if (
              stopped ||
              sessions.get(context.session.threadId) !== context ||
              context.promptAdmission !== promptAdmission ||
              context.activeTurnId !== promptAdmission.turnId ||
              context.promptGeneration !== promptAdmission.generation ||
              promptAdmission.cancelled
            ) {
              return;
            }
            const message = Option.isSome(response) ? response.value.data : undefined;
            if (message?.info.id === promptAdmission.messageId && message.info.role === "user") {
              promptAdmission.messageObserved = true;
              context.messageRoleById.set(promptAdmission.messageId, "user");
            }
          }

          const statusResponse = yield* runOpenCodeSdk("session.status", (signal) =>
            context.client.session.status(undefined, { signal }),
          ).pipe(Effect.timeout("1 second"), Effect.option);
          const stopped = yield* Ref.get(context.stopped);
          if (
            stopped ||
            sessions.get(context.session.threadId) !== context ||
            context.promptAdmission !== promptAdmission ||
            context.activeTurnId !== promptAdmission.turnId ||
            context.promptGeneration !== promptAdmission.generation ||
            promptAdmission.cancelled
          ) {
            return;
          }
          const statusData = Option.isSome(statusResponse)
            ? Option.getOrUndefined(decodeOpenCodeSessionStatusMap(statusResponse.value.data))
            : undefined;
          const status = statusData?.[context.openCodeSessionId];
          const isIdle =
            statusData !== undefined && (status === undefined || status.type === "idle");
          const isBusy = status?.type === "busy" || status?.type === "retry";
          if (isBusy) {
            promptAdmission.busyObserved = true;
            promptAdmission.idleStatusConfirmations = 0;
            context.awaitingBusyAfterInterruption = false;
            context.promptAdmission = undefined;
            return;
          }

          const idle = promptAdmission.idleDuringAdmission ?? promptAdmission.priorIdle;
          if (
            isIdle &&
            idle !== undefined &&
            (promptAdmission.messageObserved || promptAdmission.busyObserved)
          ) {
            context.promptAdmission = undefined;
            context.awaitingBusyAfterInterruption = false;
            yield* scheduleIdleReconciliation(context, promptAdmission.turnId, idle.raw);
            return;
          }
          if (isIdle && promptAdmission.messageObserved) {
            promptAdmission.idleStatusConfirmations += 1;
            if (promptAdmission.idleStatusConfirmations >= 2) {
              context.promptAdmission = undefined;
              context.awaitingBusyAfterInterruption = false;
              yield* completeOpenCodeTurn(
                context,
                promptAdmission.turnId,
                promptAdmission.generation,
                {
                  type: "session.status.recovered",
                  status: statusData,
                },
              );
              return;
            }
          } else if (!isIdle) {
            promptAdmission.idleStatusConfirmations = 0;
          }
          if (
            isIdle &&
            promptAdmission.messageObserved &&
            promptAdmission.recoveryRaw !== undefined
          ) {
            context.promptAdmission = undefined;
            context.awaitingBusyAfterInterruption = false;
            yield* scheduleIdleReconciliation(
              context,
              promptAdmission.turnId,
              promptAdmission.recoveryRaw,
            );
            return;
          }

          const delayMs = Math.min(250 * 2 ** retryCount, 2_000);
          yield* Effect.sleep(`${delayMs} millis`);
        }
        yield* failPromptAdmissionRecovery(context, promptAdmission);
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            delete promptAdmission.recoveryFiber;
          }),
        ),
      );
      promptAdmission.recoveryFiber = yield* recover.pipe(Effect.forkIn(context.sessionScope));
    });

    const interruptOpenCodeTurn = Effect.fn("interruptOpenCodeTurn")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      raw?: unknown,
    ) {
      if (context.interruptedTurnId === turnId) {
        return;
      }
      yield* cancelIdleReconciliation(context);
      context.interruptedTurnId = turnId;
      context.reconcileIdleStatus = true;
      context.awaitingBusyAfterInterruption = false;
      const cancellation =
        context.cancellation?.turnId === turnId ? context.cancellation : undefined;
      if (cancellation) {
        context.cancellation = undefined;
      }
      if (context.activeTurnId === turnId) {
        context.activeTurnId = undefined;
        context.activeAgent = undefined;
        context.activeVariant = undefined;
        yield* updateProviderSession(
          context,
          { status: "ready" },
          { clearActiveTurnId: true, clearLastError: true },
        );
      }
      // Orchestration settles persisted session state from terminal completions,
      // so represent a successful user cancellation as an interrupted completion.
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          raw,
        })),
        type: "turn.completed",
        payload: {
          state: "interrupted",
        },
      });
      if (cancellation) {
        yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
      }
    });

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      // Atomic one-shot: two fibers can race here (the event-pump on stream
      // failure and the server-exit watcher). `getAndSet` flips the flag in
      // a single step so the loser observes `true` and returns; a plain
      // `Ref.get` would let both racers slip past and emit duplicates.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      yield* Deferred.fail(
        context.firstConnection,
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "event.subscribe",
          detail: "OpenCode session exited before the event stream connected.",
        }),
      ).pipe(Effect.ignore);
      yield* failPendingOpenCodeCancellation(
        context,
        "OpenCode session exited during cancellation.",
      );
      context.promptAdmission = undefined;
      const turnId = context.activeTurnId;
      deleteContextIfCurrent(context);
      // Emit lifecycle events BEFORE tearing down the scope. Both call sites
      // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
      // closing that scope triggers the fiber-interrupt finalizer, so any
      // subsequent yield point would unwind and silently drop these emits.
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      }).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      }).pipe(Effect.ignore);
      deleteSessionSequenceIfInactive(context.session.threadId);
      // Inline the teardown that `stopOpenCodeContext` would do; we can't
      // delegate to it because our `getAndSet` above already flipped the
      // one-shot guard, so the call would no-op.
      yield* abortOpenCodeSessionForTeardown(context);
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    /** Emit content.delta and item.completed events for an assistant text part. */
    const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
      context: OpenCodeSessionContext,
      part: Part,
      turnId: TurnId | undefined,
      raw: unknown,
    ) {
      const text = textFromPart(part);
      if (text === undefined) {
        return;
      }
      const previousText = context.emittedTextByPartId.get(part.id);
      const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
      context.emittedTextByPartId.set(part.id, latestText);
      if (latestText !== text) {
        context.partById.set(
          part.id,
          (part.type === "text" || part.type === "reasoning"
            ? { ...part, text: latestText }
            : part) satisfies Part,
        );
      }
      if (deltaToEmit.length > 0) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt:
              (part.type === "text" || part.type === "reasoning") && part.time !== undefined
                ? isoFromEpochMs(part.time.start)
                : undefined,
            raw,
          })),
          type: "content.delta",
          payload: {
            streamKind: resolveTextStreamKind(part),
            delta: deltaToEmit,
          },
        });
      }

      if (
        part.type === "text" &&
        part.time?.end !== undefined &&
        !context.completedAssistantPartIds.has(part.id)
      ) {
        context.completedAssistantPartIds.add(part.id);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt: isoFromEpochMs(part.time.end),
            raw,
          })),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(latestText.length > 0 ? { detail: latestText } : {}),
          },
        });
      }
    });

    const isRelatedOpenCodeSession = Effect.fn("isRelatedOpenCodeSession")(function* (
      context: OpenCodeSessionContext,
      candidateSessionId: string,
    ) {
      if (context.relatedSessionIds.has(candidateSessionId)) {
        return true;
      }

      const seen = new Set<string>();
      const getSession = (sessionID: string) =>
        runOpenCodeSdk("session.get", () => context.client.session.get({ sessionID })).pipe(
          Effect.catchIf(
            (cause) => isOpenCodeNotFound(cause),
            () => Effect.succeed(undefined),
          ),
        );
      let sessionId: string | undefined = candidateSessionId;
      for (let depth = 0; sessionId !== undefined && depth < 32; depth += 1) {
        if (context.relatedSessionIds.has(sessionId)) {
          context.relatedSessionIds.add(candidateSessionId);
          return true;
        }
        if (seen.has(sessionId)) {
          return false;
        }
        seen.add(sessionId);
        const currentSessionId: string = sessionId;
        const response = yield* getSession(currentSessionId);
        if (response === undefined) {
          return false;
        }
        if (!response.data) {
          return yield* new OpenCodeRuntimeError({
            operation: "session.get",
            detail: `OpenCode session.get returned no session payload for '${currentSessionId}'.`,
          });
        }
        sessionId = response.data.parentID;
      }
      return false;
    });

    const emitPendingOpenCodeRequest = Effect.fn("emitPendingOpenCodeRequest")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeAskedRequestEvent,
      raw: unknown,
    ) {
      if (context.resolvedRequestIds.has(event.properties.id)) {
        return;
      }
      const activation = context.taskActivationByChildSessionId.get(event.properties.sessionID);
      const turnId = activation?.turnId ?? context.activeTurnId;
      if (event.type === "permission.asked") {
        const request = event.properties;
        if (context.pendingPermissions.has(request.id)) {
          return;
        }
        context.pendingPermissions.set(request.id, request);
        if (activation) {
          yield* emitTaskStatus(context, activation, "waiting", raw);
        }
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: request.id,
            raw,
          })),
          type: "request.opened",
          payload: {
            requestType: mapPermissionToRequestType(request.permission),
            detail: request.patterns.length > 0 ? request.patterns.join("\n") : request.permission,
            args: request.metadata,
          },
        });
        return;
      }

      const request = event.properties;
      if (context.pendingQuestions.has(request.id)) {
        return;
      }
      context.pendingQuestions.set(request.id, request);
      if (activation) {
        yield* emitTaskStatus(context, activation, "waiting", raw);
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          requestId: request.id,
          raw,
        })),
        type: "user-input.requested",
        payload: { questions: normalizeQuestionRequest(request) },
      });
    });

    const resolvePendingOpenCodeRequest = Effect.fn("resolvePendingOpenCodeRequest")(function* (
      context: OpenCodeSessionContext,
      requestId: string,
    ) {
      context.resolvedRequestIds.add(requestId);
      const retry = context.requestRelationRetries.get(requestId);
      context.requestRelationRetries.delete(requestId);
      if (retry?.fiber) {
        yield* Fiber.interrupt(retry.fiber);
      }
    });

    const emitTerminalOpenCodeRequest = Effect.fn("emitTerminalOpenCodeRequest")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeTerminalRequestEvent,
    ) {
      const requestId = event.properties.requestID;
      if (context.emittedTerminalRequestIds.has(requestId)) {
        return;
      }
      context.emittedTerminalRequestIds.add(requestId);
      const activation = context.taskActivationByChildSessionId.get(event.properties.sessionID);
      const turnId = activation?.turnId ?? context.activeTurnId;
      if (activation) {
        yield* emitTaskStatus(context, activation, "running", event);
      }
      if (event.type === "permission.replied") {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId,
            raw: event,
          })),
          type: "request.resolved",
          payload: {
            requestType: "unknown",
            decision: mapPermissionDecision(event.properties.reply),
          },
        });
        return;
      }

      const request = context.pendingQuestions.get(requestId);
      const answers =
        event.type === "question.replied" && request
          ? Object.fromEntries(
              request.questions.map((question, index) => [
                openCodeQuestionId(index, question),
                event.properties.answers[index]?.join(", ") ?? "",
              ]),
            )
          : {};
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          requestId,
          raw: event,
        })),
        type: "user-input.resolved",
        payload: { answers },
      });
    });

    const scheduleRequestRelationRetry = Effect.fn("scheduleRequestRelationRetry")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeRoutedRequestEvent,
      raw: unknown = event,
    ) {
      const isAskedEvent = event.type === "permission.asked" || event.type === "question.asked";
      const requestId = isAskedEvent ? event.properties.id : event.properties.requestID;
      if (context.requestRelationRetries.has(requestId)) {
        return;
      }
      if (isAskedEvent && context.resolvedRequestIds.has(requestId)) {
        return;
      }
      const retry: OpenCodeRequestRelationRetry = { warned: false };
      context.requestRelationRetries.set(requestId, retry);
      const run = Effect.gen(function* () {
        let retryCount = 0;
        while (context.requestRelationRetries.get(requestId) === retry) {
          const relation = yield* isRelatedOpenCodeSession(
            context,
            event.properties.sessionID,
          ).pipe(
            Effect.match({
              onFailure: (cause) => ({ type: "unknown" as const, cause }),
              onSuccess: (related) => ({ type: "known" as const, related }),
            }),
          );
          if (context.requestRelationRetries.get(requestId) !== retry) {
            return;
          }
          if (relation.type === "known") {
            context.requestRelationRetries.delete(requestId);
            if (relation.related) {
              if (isAskedEvent) {
                yield* emitPendingOpenCodeRequest(context, event, raw);
              } else {
                yield* emitTerminalOpenCodeRequest(context, event);
              }
            }
            return;
          }
          if (!retry.warned) {
            retry.warned = true;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                requestId,
              })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode request routing is waiting for session ancestry.",
                detail: openCodeRuntimeErrorDetail(relation.cause),
              },
            });
          }
          const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
          retryCount += 1;
          if (!isAskedEvent && retryCount >= 5) {
            return;
          }
          yield* Effect.sleep(`${delayMs} millis`);
        }
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (context.requestRelationRetries.get(requestId) === retry) {
              context.requestRelationRetries.delete(requestId);
            }
          }),
        ),
      );
      retry.fiber = yield* run.pipe(Effect.forkIn(context.sessionScope));
    });

    const schedulePendingRequestRecovery = Effect.fn("schedulePendingRequestRecovery")(function* (
      context: OpenCodeSessionContext,
    ) {
      if (context.pendingRequestRecovery) {
        context.pendingRequestRecovery.rerun = true;
        return;
      }
      const recovery: OpenCodePendingRequestRecovery = { warned: false, rerun: false };
      context.pendingRequestRecovery = recovery;
      const run = Effect.gen(function* () {
        let retryCount = 0;
        while (context.pendingRequestRecovery === recovery) {
          const responses = yield* Effect.all({
            permissions: runOpenCodeSdk("permission.list", () => context.client.permission.list()),
            questions: runOpenCodeSdk("question.list", () => context.client.question.list()),
          }).pipe(
            Effect.match({
              onFailure: (cause) => ({ type: "failure" as const, cause }),
              onSuccess: (value) => ({ type: "success" as const, value }),
            }),
          );
          if (context.pendingRequestRecovery !== recovery) {
            return;
          }
          if (responses.type === "failure") {
            if (!recovery.warned) {
              recovery.warned = true;
              yield* emit({
                ...(yield* buildEventBase({ threadId: context.session.threadId })),
                type: "runtime.warning",
                payload: {
                  message: "OpenCode pending request recovery failed and will retry.",
                  detail: openCodeRuntimeErrorDetail(responses.cause),
                },
              });
            }
            const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
            retryCount += 1;
            yield* Effect.sleep(`${delayMs} millis`);
            continue;
          }
          const permissions = responses.value.permissions.data;
          const questions = responses.value.questions.data;
          if (permissions === undefined || questions === undefined) {
            if (!recovery.warned) {
              recovery.warned = true;
              yield* emit({
                ...(yield* buildEventBase({ threadId: context.session.threadId })),
                type: "runtime.warning",
                payload: {
                  message: "OpenCode pending request recovery returned no data and will retry.",
                },
              });
            }
            const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
            retryCount += 1;
            yield* Effect.sleep(`${delayMs} millis`);
            continue;
          }
          yield* Effect.forEach(
            permissions,
            (request) =>
              scheduleRequestRelationRetry(
                context,
                { id: `recovered:${request.id}`, type: "permission.asked", properties: request },
                { type: "permission.asked", properties: request, recovered: true },
              ),
            { discard: true },
          );
          yield* Effect.forEach(
            questions,
            (request) =>
              scheduleRequestRelationRetry(
                context,
                { id: `recovered:${request.id}`, type: "question.asked", properties: request },
                { type: "question.asked", properties: request, recovered: true },
              ),
            { discard: true },
          );
          if (recovery.rerun) {
            recovery.rerun = false;
            recovery.warned = false;
            continue;
          }
          context.pendingRequestRecovery = undefined;
          return;
        }
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (context.pendingRequestRecovery === recovery) {
              context.pendingRequestRecovery = undefined;
            }
          }),
        ),
      );
      yield* run.pipe(Effect.forkIn(context.sessionScope));
    });

    const readChildTaskOutcome = Effect.fn("readOpenCodeChildTaskOutcome")(function* (
      context: OpenCodeSessionContext,
      activation: OpenCodeTaskActivation,
    ) {
      const result = yield* runOpenCodeSdk("session.messages", () =>
        context.client.session.messages({ sessionID: activation.taskId }),
      ).pipe(Effect.option);
      if (Option.isNone(result)) {
        if (activation.candidateError) {
          yield* completeTaskActivation(
            context,
            activation,
            activation.candidateStopped ? "stopped" : "failed",
            activation.candidateError,
          );
        } else {
          yield* emitTaskStatus(context, activation, "idle", {
            source: "session.messages unavailable after child became idle",
          });
        }
        return;
      }

      const messages = result.value.data ?? [];
      const assistant = messages.toReversed().find((entry) => entry.info.role === "assistant");
      const info = assistant?.info as unknown as Record<string, unknown> | undefined;
      const error = info?.error as Record<string, unknown> | undefined;
      const errorName = typeof error?.name === "string" ? error.name : undefined;
      if (error) {
        yield* completeTaskActivation(
          context,
          activation,
          errorName === "MessageAbortedError" ? "stopped" : "failed",
          sessionErrorMessage(error),
        );
        return;
      }

      const parts = (assistant?.parts ?? []) as Array<Part>;
      const failedTool = parts
        .toReversed()
        .find((part) => part.type === "tool" && part.state.status === "error");
      if (failedTool?.type === "tool" && failedTool.state.status === "error") {
        yield* completeTaskActivation(context, activation, "failed", failedTool.state.error);
        return;
      }
      if (activation.candidateError) {
        yield* completeTaskActivation(
          context,
          activation,
          activation.candidateStopped ? "stopped" : "failed",
          activation.candidateError,
        );
        return;
      }
      const time = info?.time as Record<string, unknown> | undefined;
      if (typeof time?.completed !== "number") {
        yield* emitTaskStatus(context, activation, "idle", {
          source: "child assistant result is not complete yet",
        });
        return;
      }
      const summary = parts
        .toReversed()
        .map(textFromPart)
        .find((text) => trimText(text) !== undefined);
      yield* completeTaskActivation(
        context,
        activation,
        activation.candidateStopped
          ? "stopped"
          : activation.candidateError
            ? "failed"
            : "completed",
        activation.candidateError ?? summary,
      );
    });

    const handleToolPart = Effect.fn("handleOpenCodeToolPart")(function* (
      context: OpenCodeSessionContext,
      part: Extract<Part, { readonly type: "tool" }>,
      turnId: TurnId | undefined,
      raw: unknown,
      owningActivation?: OpenCodeTaskActivation,
      emitItem = true,
    ) {
      const previousPart = context.partById.get(part.id);
      context.partById.set(part.id, part);
      const isTask = part.tool.toLowerCase() === "task";
      const currentMetadata = taskStateMetadata(part);
      const previousMetadata = taskStateMetadata(previousPart);
      const metadata = currentMetadata ?? previousMetadata;
      const taskEnvelope =
        part.state.status === "completed"
          ? parseOpenCodeTaskEnvelope(part.state.output)
          : undefined;
      const taskDescription = isTask ? taskInputString(part, "description") : undefined;
      const taskRole = isTask ? taskInputString(part, "subagent_type") : undefined;

      if (isTask && owningActivation === undefined) {
        const metadataSessionId =
          typeof metadata?.sessionId === "string" ? trimText(metadata.sessionId) : undefined;
        const requestedTaskId = taskInputString(part, "task_id");
        const taskId = metadataSessionId ?? taskEnvelope?.id ?? requestedTaskId;
        if (taskId) {
          let activation = context.taskActivationsByCallId.get(part.callID);
          if (!activation) {
            activation = {
              taskId,
              callId: part.callID,
              turnId,
              description: taskDescription,
              role: taskRole,
              model: taskModel(metadata),
              background: metadata?.background === true,
              resumed: requestedTaskId === taskId,
              lifecycleEmitted: false,
              terminal: false,
              candidateError: undefined,
              candidateStopped: false,
            };
            context.taskActivationsByCallId.set(part.callID, activation);
          }
          context.taskActivationByChildSessionId.set(taskId, activation);
          context.relatedSessionIds.add(taskId);
          yield* emitTaskActivation(context, activation, toolStateStartedAt(part));

          if (part.state.status === "completed") {
            if (!(activation.background && taskEnvelope?.state === "running")) {
              yield* completeTaskActivation(
                context,
                activation,
                taskEnvelope?.state === "error" ? "failed" : "completed",
                taskEnvelope?.error ?? taskEnvelope?.result ?? part.state.output,
                toolStateCreatedAt(part),
              );
            }
          } else if (part.state.status === "error") {
            yield* completeTaskActivation(
              context,
              activation,
              "failed",
              part.state.error,
              toolStateCreatedAt(part),
            );
          }
        }
      }

      if (!owningActivation && part.tool.toLowerCase() === "todowrite") {
        const plan = parseOpenCodePlan(part.state.input.todos);
        if (plan !== null && recordOpenCodePlan(context, turnId, plan)) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              createdAt: toolStateCreatedAt(part),
              raw,
            })),
            type: "turn.plan.updated",
            payload: { plan },
          });
        }
      }

      if (!emitItem) {
        return;
      }

      const itemType = toToolLifecycleItemType(part.tool);
      const isGrep = part.tool.toLowerCase() === "grep";
      const title = isTask
        ? "Task"
        : isGrep
          ? "Grep"
          : part.state.status === "running"
            ? (part.state.title ?? part.tool)
            : part.tool;
      const rawDetail = detailFromToolPart(part);
      const readOutput =
        part.tool === "read" && part.state.status === "completed"
          ? parseOpenCodeReadOutput(part.state.output)
          : null;
      const grepOutput =
        isGrep && part.state.status === "completed"
          ? (parseOpenCodeGrepOutput(part.state.output)?.content ?? part.state.output)
          : null;
      const taskDetail =
        isTask && part.state.status === "completed"
          ? (taskEnvelope?.result ?? taskEnvelope?.error ?? rawDetail)
          : rawDetail;
      const detail = readOutput?.content ?? grepOutput ?? taskDetail;
      const command =
        part.tool === "bash" && typeof part.state.input.command === "string"
          ? part.state.input.command
          : undefined;
      const readInputPath =
        part.tool === "read" && typeof part.state.input.filePath === "string"
          ? part.state.input.filePath.trim()
          : "";
      const readPath = readOutput?.path ?? readInputPath;
      const taskFailed = isTask && taskEnvelope?.state === "error";
      const payload = {
        itemType,
        ...(part.state.status === "error" || taskFailed
          ? { status: "failed" as const }
          : part.state.status === "completed"
            ? { status: "completed" as const }
            : { status: "inProgress" as const }),
        ...(title ? { title } : {}),
        ...(detail ? { detail } : {}),
        ...(owningActivation ? { agentId: owningActivation.taskId } : {}),
        data: {
          tool: part.tool,
          state: part.state,
          ...(isTask ? { kind: "task", description: taskDescription } : {}),
          ...(isTask && taskEnvelope?.state === "completed" ? { detailFormat: "markdown" } : {}),
          ...(owningActivation ? { parentToolUseId: owningActivation.callId } : {}),
          ...(isGrep
            ? { toolCallId: part.callID, kind: "search", rawInput: part.state.input }
            : {}),
          ...(command ? { command } : {}),
          ...(part.tool === "read" ? { kind: "read" } : {}),
          ...(readPath ? { files: [{ path: readPath }] } : {}),
        },
      };
      const runtimeEvent: ProviderRuntimeEvent = {
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: owningActivation?.turnId ?? turnId,
          itemId: part.callID,
          createdAt: toolStateCreatedAt(part),
          raw,
        })),
        type:
          part.state.status === "pending"
            ? "item.started"
            : part.state.status === "completed" || part.state.status === "error"
              ? "item.completed"
              : "item.updated",
        payload,
      };
      if (!owningActivation) {
        appendTurnItem(context, turnId, part);
      }
      yield* emit(runtimeEvent);

      const childToolKey = owningActivation
        ? `${owningActivation.taskId}:${part.callID}`
        : undefined;
      if (
        owningActivation &&
        childToolKey &&
        part.state.status !== "pending" &&
        !context.reportedChildToolCallIds.has(childToolKey)
      ) {
        context.reportedChildToolCallIds.add(childToolKey);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: owningActivation.turnId,
            createdAt: toolStateCreatedAt(part),
            raw,
          })),
          type: "tool.progress",
          payload: {
            taskId: RuntimeTaskId.make(owningActivation.taskId),
            toolUseId: part.callID,
            toolName: part.tool,
            parentToolUseId: owningActivation.callId,
          },
        });
      }
    });

    const handleDirectChildEvent = Effect.fn("handleOpenCodeDirectChildEvent")(function* (
      context: OpenCodeSessionContext,
      activation: OpenCodeTaskActivation,
      event: OpenCodeSubscribedEvent,
    ) {
      switch (event.type) {
        case "message.updated":
          context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
          break;
        case "message.removed":
          context.messageRoleById.delete(event.properties.messageID);
          break;
        case "message.part.updated": {
          const part = event.properties.part;
          if (part.type === "tool") {
            yield* handleToolPart(context, part, activation.turnId, event, activation);
          } else {
            context.partById.set(part.id, part);
          }
          break;
        }
        case "session.status":
          if (event.properties.status.type === "busy") {
            yield* emitTaskStatus(context, activation, "running", event);
          } else if (event.properties.status.type === "retry") {
            if (activation.description) {
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId: activation.turnId,
                  raw: event,
                })),
                type: "task.progress",
                payload: {
                  taskId: RuntimeTaskId.make(activation.taskId),
                  description: activation.description,
                  summary: event.properties.status.message,
                  status: "running",
                  ...taskLinkage(activation),
                },
              });
            }
          } else if (!activation.terminal) {
            yield* readChildTaskOutcome(context, activation);
          }
          break;
        case "session.idle":
          if (!activation.terminal) {
            yield* readChildTaskOutcome(context, activation);
          }
          break;
        case "session.error": {
          const error = event.properties.error;
          activation.candidateError = sessionErrorMessage(error);
          activation.candidateStopped =
            error !== null &&
            typeof error === "object" &&
            "name" in error &&
            error.name === "MessageAbortedError";
          break;
        }
        case "permission.asked":
          yield* emitPendingOpenCodeRequest(context, event, event);
          break;
        case "permission.replied":
          context.pendingPermissions.delete(event.properties.requestID);
          yield* emitTerminalOpenCodeRequest(context, event);
          break;
        case "question.asked":
          yield* emitPendingOpenCodeRequest(context, event, event);
          break;
        case "question.replied":
          yield* emitTerminalOpenCodeRequest(context, event);
          context.pendingQuestions.delete(event.properties.requestID);
          break;
        case "question.rejected":
          context.pendingQuestions.delete(event.properties.requestID);
          yield* emitTerminalOpenCodeRequest(context, event);
          break;
        default:
          break;
      }
    });

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      if (event.type === "server.connected") {
        if (
          (yield* Ref.get(context.stopped)) ||
          sessions.get(context.session.threadId) !== context
        ) {
          return;
        }
        const isFirstConnection = !(yield* Deferred.isDone(context.firstConnection));
        if (isFirstConnection) {
          const updatedAt = yield* nowIso;
          if (
            (yield* Ref.get(context.stopped)) ||
            sessions.get(context.session.threadId) !== context
          ) {
            return;
          }
          applyProviderSessionUpdate(context, { status: "ready" }, undefined, updatedAt);
          if (!(yield* Deferred.succeed(context.firstConnection, undefined))) {
            return;
          }
        }
        yield* schedulePendingRequestRecovery(context);
        if (!isFirstConnection) {
          yield* schedulePromptAdmissionRecovery(context, event);
        }
        return;
      }
      const terminalRequestId =
        event.type === "permission.replied" ||
        event.type === "question.replied" ||
        event.type === "question.rejected"
          ? event.properties.requestID
          : undefined;
      if (terminalRequestId !== undefined) {
        yield* resolvePendingOpenCodeRequest(context, terminalRequestId);
      }
      if (event.type === "session.created" || event.type === "session.updated") {
        const session = event.properties.info;
        if (session.parentID && context.relatedSessionIds.has(session.parentID)) {
          context.relatedSessionIds.add(session.id);
        }
      } else if (event.type === "session.deleted") {
        context.relatedSessionIds.delete(event.properties.info.id);
      }

      const payloadSessionId = openCodeEventSessionId(event);
      const isParentEvent = payloadSessionId === context.openCodeSessionId;
      const childActivation =
        !isParentEvent && payloadSessionId
          ? context.taskActivationByChildSessionId.get(payloadSessionId)
          : undefined;
      let isKnownPendingTerminalEvent = false;
      if (
        payloadSessionId !== undefined &&
        childActivation === undefined &&
        !context.relatedSessionIds.has(payloadSessionId) &&
        isOpenCodeChildRequestEvent(event)
      ) {
        if (event.type === "permission.asked") {
          yield* scheduleRequestRelationRetry(context, event);
        } else if (event.type === "question.asked") {
          yield* scheduleRequestRelationRetry(context, event);
        } else if (
          event.type === "permission.replied" ||
          event.type === "question.replied" ||
          event.type === "question.rejected"
        ) {
          const requestId = event.properties.requestID;
          isKnownPendingTerminalEvent =
            context.pendingPermissions.has(requestId) || context.pendingQuestions.has(requestId);
          if (!isKnownPendingTerminalEvent) {
            yield* scheduleRequestRelationRetry(context, event);
            return;
          }
        }
      }
      const isChildRequestEvent =
        payloadSessionId !== undefined &&
        isOpenCodeChildRequestEvent(event) &&
        (context.relatedSessionIds.has(payloadSessionId) || isKnownPendingTerminalEvent);
      if (!isParentEvent && childActivation === undefined && !isChildRequestEvent) {
        return;
      }

      const turnId = childActivation?.turnId ?? context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: context.openCodeSessionId,
          type: event.type,
          ...(turnId ? { turnId } : {}),
          ...(!isParentEvent && payloadSessionId ? { childSessionId: payloadSessionId } : {}),
          payload: event,
        },
      });

      const suppressInterruptedParentOutput =
        isParentEvent &&
        ((context.activeTurnId === undefined &&
          (context.interruptedTurnId !== undefined || context.reconcileIdleStatus)) ||
          context.awaitingBusyAfterInterruption) &&
        (event.type === "message.part.delta" ||
          event.type === "message.part.updated" ||
          (event.type === "message.updated" && event.properties.info.role === "assistant"));
      if (suppressInterruptedParentOutput) {
        return;
      }

      if (childActivation) {
        yield* handleDirectChildEvent(context, childActivation, event);
        return;
      }

      switch (event.type) {
        case "session.updated": {
          const title = openCodeEventSessionTitle(event);
          if (title) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                raw: event,
              })),
              type: "thread.metadata.updated",
              payload: {
                name: title,
                metadata: {
                  sessionID: context.openCodeSessionId,
                },
              },
            });
          }
          break;
        }

        case "session.compacted": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "thread.state.changed",
            payload: {
              state: "compacted",
              detail: event,
            },
          });
          break;
        }

        case "message.updated": {
          const info = event.properties.info;
          const promptAdmission = context.promptAdmission;
          if (info.role === "user" && promptAdmission?.messageId === info.id) {
            promptAdmission.messageObserved = true;
            if (promptAdmission.accepted) {
              const idle = promptAdmission.idleDuringAdmission;
              context.awaitingBusyAfterInterruption = false;
              context.promptAdmission = undefined;
              if (promptAdmission.recoveryFiber) {
                yield* Fiber.interrupt(promptAdmission.recoveryFiber);
              }
              if (idle) {
                yield* scheduleIdleReconciliation(context, idle.turnId, idle.raw);
              }
            }
          }
          context.messageRoleById.set(info.id, info.role);
          if (info.role === "assistant") {
            for (const part of context.partById.values()) {
              if (part.messageID !== info.id) {
                continue;
              }
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }

            if (info.time?.completed !== undefined && info.tokens) {
              // Match OpenCode's own overflow calculation so the meter reports
              // the same context pressure that triggers provider compaction.
              const usedTokens =
                info.tokens.total ||
                info.tokens.input +
                  info.tokens.output +
                  info.tokens.cache.read +
                  info.tokens.cache.write;
              if (usedTokens > 0) {
                const cachedInputTokens = info.tokens.cache.read + info.tokens.cache.write;
                const maxTokens = context.modelContextLimitBySlug.get(
                  `${info.providerID}/${info.modelID}`,
                );
                yield* emit({
                  ...(yield* buildEventBase({
                    threadId: context.session.threadId,
                    turnId,
                    createdAt: isoFromEpochMs(info.time.completed),
                    raw: event,
                  })),
                  type: "thread.token-usage.updated",
                  payload: {
                    usage: {
                      usedTokens,
                      lastUsedTokens: usedTokens,
                      inputTokens: info.tokens.input,
                      cachedInputTokens,
                      outputTokens: info.tokens.output,
                      reasoningOutputTokens: info.tokens.reasoning,
                      lastInputTokens: info.tokens.input,
                      lastCachedInputTokens: cachedInputTokens,
                      lastOutputTokens: info.tokens.output,
                      lastReasoningOutputTokens: info.tokens.reasoning,
                      ...(maxTokens !== undefined ? { maxTokens } : {}),
                    },
                  },
                });
              }
            }
          }
          break;
        }

        case "message.removed": {
          context.messageRoleById.delete(event.properties.messageID);
          break;
        }

        case "message.part.delta": {
          const existingPart = context.partById.get(event.properties.partID);
          if (!existingPart) {
            break;
          }
          const role = messageRoleForPart(context, existingPart);
          if (role !== "assistant") {
            break;
          }
          const streamKind = resolveTextStreamKind(existingPart);
          const delta = event.properties.delta;
          if (delta.length === 0) {
            break;
          }
          const previousText =
            context.emittedTextByPartId.get(event.properties.partID) ??
            textFromPart(existingPart) ??
            "";
          const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
          if (deltaToEmit.length === 0) {
            break;
          }
          context.emittedTextByPartId.set(event.properties.partID, nextText);
          if (existingPart.type === "text" || existingPart.type === "reasoning") {
            context.partById.set(event.properties.partID, {
              ...existingPart,
              text: nextText,
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.properties.partID,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind,
              delta: deltaToEmit,
            },
          });
          break;
        }

        case "message.part.updated": {
          const part = event.properties.part;
          if (part.type === "tool") {
            yield* handleToolPart(context, part, turnId, event);
            break;
          }

          context.partById.set(part.id, part);
          const messageRole = messageRoleForPart(context, part);

          const taskEnvelope =
            part.type === "text" && part.synthetic === true
              ? parseOpenCodeTaskEnvelope(part.text)
              : null;
          if (taskEnvelope) {
            if (taskEnvelope.state !== "running") {
              const activation = context.taskActivationByChildSessionId.get(taskEnvelope.id);
              if (activation) {
                yield* completeTaskActivation(
                  context,
                  activation,
                  taskEnvelope.state === "error" ? "failed" : "completed",
                  taskEnvelope.error ?? taskEnvelope.result,
                );
              }
            }
            // OpenCode injects these control envelopes to wake the parent after
            // background work; they are not assistant-authored transcript text.
            break;
          }

          if (messageRole === "assistant") {
            yield* emitAssistantTextDelta(context, part, turnId, event);
          }
          break;
        }

        case "permission.asked": {
          yield* emitPendingOpenCodeRequest(context, event, event);
          break;
        }

        case "permission.replied": {
          context.pendingPermissions.delete(event.properties.requestID);
          yield* emitTerminalOpenCodeRequest(context, event);
          break;
        }

        case "question.asked": {
          yield* emitPendingOpenCodeRequest(context, event, event);
          break;
        }

        case "question.replied": {
          yield* emitTerminalOpenCodeRequest(context, event);
          context.pendingQuestions.delete(event.properties.requestID);
          break;
        }

        case "question.rejected": {
          context.pendingQuestions.delete(event.properties.requestID);
          yield* emitTerminalOpenCodeRequest(context, event);
          break;
        }

        case "session.status": {
          if (event.properties.status.type === "busy") {
            if (turnId === undefined) {
              break;
            }
            yield* cancelIdleReconciliation(context);
            context.awaitingBusyAfterInterruption = false;
            if (context.promptAdmission?.turnId === turnId) {
              context.promptAdmission.busyObserved = true;
              yield* schedulePromptAdmissionRecovery(context, event);
            }
            yield* updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }

          if (event.properties.status.type === "retry") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: event.properties.status.message,
                detail: event.properties.status,
              },
            });
            break;
          }

          if (event.properties.status.type === "idle" && turnId) {
            if (context.cancellation?.turnId === turnId) {
              context.cancellation.deferredIdleEvent = event;
              break;
            }
            if (context.promptAdmission?.turnId === turnId) {
              context.promptAdmission.idleDuringAdmission = { turnId, raw: event };
              context.promptAdmission.idleObservedAfterMessage =
                context.promptAdmission.messageObserved;
              yield* schedulePromptAdmissionRecovery(context, event);
              break;
            }
            if (context.awaitingBusyAfterInterruption) {
              break;
            }
            if (context.reconcileIdleStatus) {
              yield* scheduleIdleReconciliation(context, turnId, event);
              break;
            }
            yield* completeOpenCodeTurn(context, turnId, context.promptGeneration, event);
          }
          break;
        }

        case "session.error": {
          const message = sessionErrorMessage(event.properties.error);
          const activeTurnId = context.activeTurnId;
          const cancellation = context.cancellation;
          if (isOpenCodeAbortError(event.properties.error)) {
            if (cancellation !== undefined && cancellation.turnId === undefined) {
              cancellation.acknowledged = true;
              yield* Deferred.succeed(cancellation.acknowledgment, undefined).pipe(Effect.ignore);
              break;
            }
            if (activeTurnId !== undefined && cancellation?.turnId === activeTurnId) {
              cancellation.acknowledged = true;
              yield* Deferred.succeed(cancellation.acknowledgment, undefined).pipe(Effect.ignore);
              break;
            }
            if (context.interruptedTurnId !== undefined || context.reconcileIdleStatus) {
              break;
            }
          }
          yield* cancelIdleReconciliation(context);
          const terminalCancellation =
            activeTurnId !== undefined && cancellation?.turnId === activeTurnId
              ? cancellation
              : undefined;
          if (terminalCancellation) {
            terminalCancellation.turnSettled = true;
            terminalCancellation.acknowledged = true;
          }
          context.activeTurnId = undefined;
          context.activeAgent = undefined;
          context.activeVariant = undefined;
          context.reconcileIdleStatus = false;
          yield* updateProviderSession(
            context,
            {
              status: "error",
              lastError: message,
            },
            { clearActiveTurnId: true },
          );
          if (activeTurnId) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: activeTurnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
              },
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: event.properties.error,
            },
          });
          if (terminalCancellation) {
            yield* Deferred.succeed(terminalCancellation.acknowledgment, undefined).pipe(
              Effect.ignore,
            );
          }
          break;
        }

        default:
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
      // One AbortController per session scope. The finalizer fires when
      // the scope closes (explicit stop, unexpected exit, or layer
      // shutdown) and cancels the in-flight `event.subscribe` fetch so
      // the async iterable unwinds cleanly.
      const eventsAbortController = new AbortController();
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );

      // Fibers forked into `context.sessionScope` are interrupted
      // automatically when the scope closes — no bookkeeping required.
      yield* Effect.flatMap(
        runOpenCodeSdk("event.subscribe", () =>
          context.client.event.subscribe(undefined, {
            signal: eventsAbortController.signal,
          }),
        ),
        (subscription) =>
          Stream.fromAsyncIterable(
            subscription.stream,
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "event.subscribe",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event))),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            // Expected paths: caller aborted the fetch or the session
            // has already been marked stopped. Treat as a clean exit.
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            if (Exit.isFailure(exit)) {
              yield* emitUnexpectedExit(
                context,
                openCodeRuntimeErrorDetail(Cause.squash(exit.cause)),
              );
            }
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

    const reconcileOpenCodeTaskMessages = Effect.fn("reconcileOpenCodeTaskMessages")(function* (
      context: OpenCodeSessionContext,
    ) {
      const messagesResult = yield* runOpenCodeSdk("session.messages", () =>
        context.client.session.messages({ sessionID: context.openCodeSessionId }),
      ).pipe(Effect.option);
      if (Option.isNone(messagesResult)) {
        return;
      }

      for (const entry of messagesResult.value.data ?? []) {
        context.messageRoleById.set(entry.info.id, entry.info.role);
        for (const rawPart of entry.parts) {
          const part = rawPart as Part;
          if (part.type === "tool" && part.tool.toLowerCase() === "task") {
            yield* handleToolPart(context, part, undefined, { reconciled: true }, undefined, false);
            continue;
          }

          const envelope =
            part.type === "text" && part.synthetic === true
              ? parseOpenCodeTaskEnvelope(part.text)
              : null;
          if (envelope && envelope.state !== "running") {
            const activation = context.taskActivationByChildSessionId.get(envelope.id);
            if (activation) {
              yield* completeTaskActivation(
                context,
                activation,
                envelope.state === "error" ? "failed" : "completed",
                envelope.error ?? envelope.result,
              );
            }
          }
        }
      }
    });

    const reconcileOpenCodeTaskStatuses = Effect.fn("reconcileOpenCodeTaskStatuses")(function* (
      context: OpenCodeSessionContext,
    ) {
      const statusResult = yield* runOpenCodeSdk("session.status", () =>
        context.client.session.status(),
      ).pipe(Effect.option);
      if (Option.isNone(statusResult)) {
        return;
      }
      const statuses = statusResult.value.data;
      for (const activation of context.taskActivationByChildSessionId.values()) {
        if (activation.terminal) {
          continue;
        }
        const status = statuses?.[activation.taskId];
        if (status?.type === "busy" || status?.type === "retry") {
          continue;
        }
        yield* readChildTaskOutcome(context, activation);
      }
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const resumeSessionId = parseOpenCodeResume(input.resumeCursor)?.sessionId;
        const existing = sessions.get(input.threadId);
        if (existing) {
          if (existing.session.status === "connecting" && !(yield* Ref.get(existing.stopped))) {
            return (yield* awaitOpenCodeContextReady(existing)).session;
          }
          yield* stopOpenCodeContext(existing);
          deleteContextIfCurrent(existing);
          deleteSessionSequenceIfInactive(input.threadId);
        }

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              // The runtime binds the server's lifetime to the Scope.Scope
              // we provide below — closing `sessionScope` kills the child
              // process automatically. No manual `server.close()` needed.
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                binaryPath,
                directory,
                serverUrl,
                ...(serverPassword ? { serverPassword } : {}),
                ...(options?.environment ? { environment: options.environment } : {}),
              });
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
              });
              const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
              if (mcpSession && !server.external) {
                yield* runOpenCodeSdk("mcp.add", () =>
                  client.mcp.add({
                    name: "t3-code",
                    config: {
                      type: "remote",
                      url: mcpSession.endpoint,
                      headers: {
                        Authorization: mcpSession.authorizationHeader,
                      },
                      oauth: false,
                    },
                  }),
                );
              }
              // Resume: re-adopt the session named by the durable cursor —
              // OpenCode scopes history by session id. The probe recovers only
              // a confirmed not-found (start fresh); transport/auth/server
              // errors propagate instead of masking as a new empty session.
              const resolved = yield* Effect.gen(function* () {
                const adopted = resumeSessionId
                  ? yield* runOpenCodeSdk("session.get", () =>
                      client.session.get({ sessionID: resumeSessionId }),
                    ).pipe(
                      Effect.map((response) => response.data),
                      Effect.catchIf(
                        (cause) => isOpenCodeNotFound(cause),
                        () => Effect.void,
                      ),
                    )
                  : undefined;

                // Reuse in place only when the session still matches the
                // requested cwd; on a cwd change it is forked below instead.
                const reusable =
                  adopted &&
                  (!adopted.directory || (yield* sameDirectory(adopted.directory, directory)))
                    ? adopted
                    : undefined;

                if (reusable) {
                  // Resume skips `session.create`, so re-assert the ruleset —
                  // a runtime-mode change would otherwise leave the session on
                  // its original permissions.
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: reusable.id,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
                  return { openCodeSession: reusable, created: false };
                }

                // The session lives under a different cwd (e.g. the thread
                // moved into a git worktree). Fork it into the requested
                // directory instead of minting an empty one — the fork carries
                // the full history, so the follow-up keeps its context (#3604).
                if (adopted) {
                  yield* Effect.logInfo(
                    `OpenCode session '${adopted.id}' was created under a different working directory; forking into '${directory}' to preserve conversation history.`,
                  );
                  const forkedSession = yield* runOpenCodeSdk("session.fork", () =>
                    client.session.fork({ sessionID: adopted.id, directory }),
                  );
                  const forked = forkedSession.data;
                  if (!forked) {
                    return yield* new OpenCodeRuntimeError({
                      operation: "session.fork",
                      detail: "OpenCode session.fork returned no session payload.",
                    });
                  }
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: forked.id,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
                  return { openCodeSession: forked, created: true };
                }

                if (resumeSessionId) {
                  yield* Effect.logWarning(
                    `OpenCode session '${resumeSessionId}' no longer exists; starting a fresh session.`,
                  );
                }
                const createdSession = yield* runOpenCodeSdk("session.create", () =>
                  client.session.create({
                    ...(input.title ? { title: input.title } : {}),
                    permission: buildOpenCodePermissionRules(input.runtimeMode),
                  }),
                );
                if (!createdSession.data) {
                  return yield* new OpenCodeRuntimeError({
                    operation: "session.create",
                    detail: "OpenCode session.create returned no session payload.",
                  });
                }
                return { openCodeSession: createdSession.data, created: true };
              });

              const modelContextLimitBySlug = yield* openCodeRuntime
                .loadOpenCodeInventory(client)
                .pipe(
                  Effect.map((inventory) => {
                    const limits = new Map<string, number>();
                    for (const provider of inventory.providerList.all) {
                      for (const model of Object.values(provider.models)) {
                        if (Number.isSafeInteger(model.limit.context) && model.limit.context > 0) {
                          limits.set(`${provider.id}/${model.id}`, model.limit.context);
                        }
                      }
                    }
                    return limits;
                  }),
                  // Context metadata must not make a working provider session unusable.
                  Effect.catch((cause) =>
                    Effect.logWarning(
                      `Failed to load OpenCode model context limits: ${cause.detail}`,
                    ).pipe(Effect.as(new Map<string, number>())),
                  ),
                );

              return {
                sessionScope,
                server,
                client,
                openCodeSession: resolved.openCodeSession,
                created: resolved.created,
                modelContextLimitBySlug,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
          }
          return startedExit.value;
        });

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          // ProviderService persists this cursor and feeds it back into
          // `startSession` after the in-memory session is lost (reaper /
          // restart), so follow-ups continue the same conversation (#3604).
          resumeCursor: {
            schemaVersion: OPENCODE_RESUME_VERSION,
            sessionId: started.openCodeSession.id,
          },
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeSessionContext = {
          session,
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          relatedSessionIds: new Set([started.openCodeSession.id]),
          resolvedRequestIds: new Set(),
          emittedTerminalRequestIds: new Set(),
          requestRelationRetries: new Map(),
          modelContextLimitBySlug: started.modelContextLimitBySlug,
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          partById: new Map(),
          emittedTextByPartId: new Map(),
          messageRoleById: new Map(),
          completedAssistantPartIds: new Set(),
          taskActivationsByCallId: new Map(),
          taskActivationByChildSessionId: new Map(),
          reportedChildToolCallIds: new Set(),
          reconcilingTasks: false,
          turns: [],
          lastEmittedPlan: undefined,
          activeTurnId: undefined,
          activeAgent: undefined,
          activeVariant: undefined,
          cancellation: undefined,
          interruptedTurnId: undefined,
          reconcileIdleStatus: false,
          awaitingBusyAfterInterruption: false,
          pendingIdleReconciliation: undefined,
          pendingRequestRecovery: undefined,
          promptGeneration: 0,
          promptAdmission: undefined,
          promptSemaphore: Semaphore.makeUnsafe(1),
          firstConnection: Deferred.makeUnsafe<void, ProviderAdapterRequestError>(),
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          // Another start published first. A newly created remote session
          // belongs to this loser; a resumed session is shared upstream state.
          yield* closeStartingOpenCodeContext(context, started.created);
          return (yield* awaitOpenCodeContextReady(raceWinner)).session;
        }
        sessions.set(input.threadId, context);
        const cleanupStartingContext = closeStartingOpenCodeContext(context, started.created).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              deleteContextIfCurrent(context);
              deleteSessionSequenceIfInactive(input.threadId);
            }),
          ),
        );
        const connectionExit = yield* Effect.gen(function* () {
          if (!started.created) {
            context.reconcilingTasks = true;
            yield* reconcileOpenCodeTaskMessages(context).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  context.reconcilingTasks = false;
                }),
              ),
            );
          }
          yield* startEventPump(context);
          yield* Deferred.await(context.firstConnection).pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "event.subscribe",
                  detail: "OpenCode event stream did not connect within 10 seconds.",
                  cause,
                }),
            ),
          );
        }).pipe(
          Effect.onInterrupt(() => cleanupStartingContext),
          Effect.exit,
        );
        if (Exit.isFailure(connectionExit)) {
          yield* cleanupStartingContext;
          return yield* Effect.failCause(connectionExit.cause);
        }
        yield* awaitOpenCodeContextReady(context);
        if (!started.created) {
          yield* schedulePendingRequestRecovery(context);
        }

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });
        if (!started.created) {
          yield* reconcileOpenCodeTaskStatuses(context);
        }

        return context.session;
      },
    );

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = yield* ensureSessionContext(sessions, input.threadId);
      yield* awaitOpenCodeContextReady(context);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }

      const text = input.input?.trim();
      // OpenCode ingests images, text, and PDFs natively; formats its model
      // paths reject ride only as the prompt's file path line.
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!text || text.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }
      const isCompaction = text === "/compact";
      if (isCompaction && fileParts.length > 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode compaction cannot include attachments.",
        });
      }
      return yield* context.promptSemaphore.withPermit(
        Effect.gen(function* () {
          const freshTurnId = TurnId.make(`opencode-turn-${yield* randomUUIDv4}`);
          const pendingCancellation = context.cancellation;
          if (pendingCancellation) {
            const cancellationResult = yield* Deferred.await(pendingCancellation.completion).pipe(
              Effect.result,
            );
            if ((yield* Ref.get(context.stopped)) || sessions.get(input.threadId) !== context) {
              return yield* Effect.interrupt;
            }
            if (cancellationResult._tag === "Failure") {
              return yield* cancellationResult.failure;
            }
          }
          if (sessions.get(input.threadId) !== context || (yield* Ref.get(context.stopped))) {
            return yield* Effect.interrupt;
          }
          // A sendTurn while a turn is active is a steer. OpenCode queues the
          // prompt into the running session, so the active turn id is reused.
          const steeringTurnId = context.activeTurnId;
          if (isCompaction && steeringTurnId !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "OpenCode compaction requires an idle session.",
            });
          }
          // Summarization has no user-message echo, so it cannot use the
          // prompt-admission recovery path below.
          if (isCompaction) {
            const turnId = freshTurnId;
            const promptGeneration = context.promptGeneration + 1;
            context.promptGeneration = promptGeneration;
            yield* cancelIdleReconciliation(context);
            context.activeTurnId = turnId;
            context.activeAgent = undefined;
            context.activeVariant = undefined;
            context.awaitingBusyAfterInterruption = context.interruptedTurnId !== undefined;
            yield* updateProviderSession(
              context,
              {
                status: "running",
                activeTurnId: turnId,
                model: modelSelection?.model ?? context.session.model,
              },
              { clearLastError: true },
            );
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.started",
              payload: {
                model: modelSelection?.model ?? context.session.model,
              },
            });

            const compactionExit = yield* runOpenCodeSdk("session.summarize", (signal) =>
              context.client.session.summarize(
                {
                  sessionID: context.openCodeSessionId,
                  providerID: parsedModel.providerID,
                  modelID: parsedModel.modelID,
                  auto: false,
                },
                { signal },
              ),
            ).pipe(
              Effect.asVoid,
              Effect.mapError(toRequestError),
              Effect.tapError((requestError) =>
                Effect.gen(function* () {
                  if (
                    (yield* Ref.get(context.stopped)) ||
                    sessions.get(input.threadId) !== context ||
                    context.activeTurnId !== turnId ||
                    context.promptGeneration !== promptGeneration ||
                    context.cancellation?.turnId === turnId
                  ) {
                    return;
                  }
                  context.activeTurnId = undefined;
                  context.activeAgent = undefined;
                  context.activeVariant = undefined;
                  context.awaitingBusyAfterInterruption = false;
                  yield* updateProviderSession(
                    context,
                    {
                      status: "ready",
                      model: modelSelection?.model ?? context.session.model,
                      lastError: requestError.detail,
                    },
                    { clearActiveTurnId: true },
                  );
                  yield* emit({
                    ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                    type: "turn.aborted",
                    payload: { reason: requestError.detail },
                  });
                }),
              ),
              Effect.exit,
            );
            const finalCancellation = context.cancellation;
            const intentionallyCancelled =
              (yield* Ref.get(context.stopped)) ||
              sessions.get(input.threadId) !== context ||
              context.promptGeneration !== promptGeneration ||
              context.interruptedTurnId === turnId ||
              finalCancellation?.turnId === turnId;
            if (Exit.isFailure(compactionExit) && !intentionallyCancelled) {
              return yield* Effect.failCause(compactionExit.cause);
            }
            if (intentionallyCancelled) {
              if (finalCancellation?.turnId === turnId) {
                yield* Deferred.await(finalCancellation.completion).pipe(Effect.result);
              }
              return yield* Effect.interrupt;
            }

            return {
              threadId: input.threadId,
              turnId,
              ...(context.session.resumeCursor !== undefined
                ? { resumeCursor: context.session.resumeCursor }
                : {}),
            };
          }

          const messageId = yield* makeOpenCodeMessageId();
          const turnId = steeringTurnId ?? freshTurnId;
          const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
          const variant = getModelSelectionStringOptionValue(modelSelection, "variant");
          const pendingIdleReconciliation = context.pendingIdleReconciliation;
          const priorAwaitingBusy = context.awaitingBusyAfterInterruption;
          const priorIdleCandidate = pendingIdleReconciliation
            ? {
                turnId: pendingIdleReconciliation.turnId,
                raw: pendingIdleReconciliation.raw,
              }
            : undefined;
          context.pendingIdleReconciliation = undefined;
          const promptGeneration = context.promptGeneration + 1;
          const promptAdmission: OpenCodePromptAdmission = {
            generation: promptGeneration,
            turnId,
            messageId,
            priorAwaitingBusy,
            priorIdle: priorIdleCandidate,
            idleDuringAdmission: undefined,
            idleObservedAfterMessage: false,
            messageObserved: false,
            busyObserved: false,
            idleStatusConfirmations: 0,
            accepted: false,
            cancelled: false,
            acceptance: Deferred.makeUnsafe<void>(),
            submissionSettled: Deferred.makeUnsafe<void>(),
            recoveryRaw: undefined,
          };
          context.promptGeneration = promptGeneration;
          context.promptAdmission = promptAdmission;

          context.activeTurnId = turnId;
          context.activeAgent = agent ?? (input.interactionMode === "plan" ? "plan" : undefined);
          context.activeVariant = variant;
          if (steeringTurnId === undefined) {
            context.awaitingBusyAfterInterruption = context.interruptedTurnId !== undefined;
          }
          if (pendingIdleReconciliation?.fiber) {
            yield* Fiber.interrupt(pendingIdleReconciliation.fiber);
          }
          yield* updateProviderSession(
            context,
            {
              status: "running",
              activeTurnId: turnId,
              model: modelSelection?.model ?? context.session.model,
            },
            { clearLastError: true },
          );

          if (steeringTurnId === undefined) {
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.started",
              payload: {
                model: modelSelection?.model ?? context.session.model,
                ...(variant ? { effort: variant } : {}),
              },
            });

            // Todo progress is ancillary; a failed or slow snapshot must not
            // prevent OpenCode from receiving the user's prompt.
            const todoResponse = yield* runOpenCodeSdk("session.todo", (signal) =>
              context.client.session.todo({ sessionID: context.openCodeSessionId }, { signal }),
            ).pipe(Effect.timeout("1 second"), Effect.option);
            const plan = Option.isSome(todoResponse)
              ? parseOpenCodePlan(todoResponse.value.data)
              : null;
            if (
              plan !== null &&
              plan.some((step) => step.status !== "completed") &&
              !promptAdmission.cancelled &&
              !(yield* Ref.get(context.stopped)) &&
              sessions.get(input.threadId) === context &&
              recordOpenCodePlan(context, turnId, plan)
            ) {
              yield* emit({
                ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                type: "turn.plan.updated",
                payload: { plan },
              });
            }
          }

          if (promptAdmission.cancelled || (yield* Ref.get(context.stopped))) {
            yield* Deferred.succeed(promptAdmission.submissionSettled, undefined).pipe(
              Effect.ignore,
            );
            const cancellation = context.cancellation;
            if (cancellation?.turnId === turnId) {
              yield* Deferred.await(cancellation.completion).pipe(Effect.result);
            }
            return yield* Effect.interrupt;
          }

          let promptTimedOut = false;
          const promptEffect = runOpenCodeSdk("session.promptAsync", (signal) =>
            context.client.session.promptAsync(
              {
                sessionID: context.openCodeSessionId,
                messageID: messageId,
                model: parsedModel,
                ...(context.activeAgent ? { agent: context.activeAgent } : {}),
                ...(context.activeVariant ? { variant: context.activeVariant } : {}),
                parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
              },
              { signal },
            ),
          ).pipe(
            Effect.timeout("10 seconds"),
            Effect.catchTags({
              OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
              TimeoutError: (cause) => {
                promptTimedOut = true;
                return Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.promptAsync",
                    detail: "OpenCode prompt submission did not complete within 10 seconds.",
                    cause,
                  }),
                );
              },
            }),
            Effect.tapError((requestError) =>
              context.promptAdmission !== promptAdmission || context.activeTurnId !== turnId
                ? Effect.void
                : Effect.gen(function* () {
                    if (!promptTimedOut) {
                      if (steeringTurnId !== undefined) {
                        context.promptAdmission = undefined;
                        context.awaitingBusyAfterInterruption = promptAdmission.priorAwaitingBusy;
                        const idle =
                          promptAdmission.idleDuringAdmission ?? promptAdmission.priorIdle;
                        if (idle) {
                          yield* scheduleIdleReconciliation(context, idle.turnId, idle.raw);
                        }
                        return;
                      }
                      context.promptAdmission = undefined;
                      context.activeTurnId = undefined;
                      context.activeAgent = undefined;
                      context.activeVariant = undefined;
                      yield* updateProviderSession(
                        context,
                        {
                          status: "ready",
                          model: modelSelection?.model ?? context.session.model,
                          lastError: requestError.detail,
                        },
                        { clearActiveTurnId: true },
                      );
                      yield* emit({
                        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                        type: "turn.aborted",
                        payload: { reason: requestError.detail },
                      });
                      return;
                    }
                    const cleanupExit = yield* Effect.exit(
                      runOpenCodeSdk("session.abort", (signal) =>
                        context.client.session.abort(
                          { sessionID: context.openCodeSessionId },
                          { signal },
                        ),
                      ).pipe(Effect.timeout("1 second")),
                    );
                    if (Exit.isFailure(cleanupExit)) {
                      yield* emit({
                        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                        type: "runtime.warning",
                        payload: {
                          message:
                            "OpenCode prompt submission failed and its cleanup abort did not complete.",
                          detail: openCodeRuntimeErrorDetail(Cause.squash(cleanupExit.cause)),
                        },
                      });
                      yield* schedulePromptAdmissionRecovery(context, {
                        requestError,
                        cleanupError: Cause.squash(cleanupExit.cause),
                      });
                      return;
                    }
                    context.promptAdmission = undefined;
                    context.activeTurnId = undefined;
                    context.activeAgent = undefined;
                    context.activeVariant = undefined;
                    context.awaitingBusyAfterInterruption = false;
                    context.reconcileIdleStatus = false;
                    yield* updateProviderSession(
                      context,
                      {
                        status: "ready",
                        model: modelSelection?.model ?? context.session.model,
                        lastError: requestError.detail,
                      },
                      { clearActiveTurnId: true },
                    );
                    yield* emit({
                      ...(yield* buildEventBase({
                        threadId: input.threadId,
                        turnId,
                      })),
                      type: "turn.aborted",
                      payload: {
                        reason: requestError.detail,
                      },
                    });
                  }),
            ),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(promptAdmission.submissionSettled, undefined).pipe(
                  Effect.ignore,
                );
                if (Exit.isFailure(exit)) {
                  yield* Deferred.succeed(promptAdmission.acceptance, undefined).pipe(
                    Effect.ignore,
                  );
                }
              }),
            ),
            Effect.asVoid,
          );
          const promptFiber = yield* promptEffect.pipe(Effect.forkIn(context.sessionScope));
          promptAdmission.promptFiber = promptFiber;
          const promptExit = yield* Effect.exit(Fiber.join(promptFiber));
          delete promptAdmission.promptFiber;

          const intentionallyCancelled =
            promptAdmission.cancelled ||
            (yield* Ref.get(context.stopped)) ||
            sessions.get(input.threadId) !== context;
          if (Exit.isFailure(promptExit) && !intentionallyCancelled) {
            return yield* Effect.failCause(promptExit.cause);
          }
          const cancelled =
            intentionallyCancelled ||
            context.activeTurnId !== turnId ||
            context.promptGeneration !== promptAdmission.generation;
          if (cancelled) {
            const cancellation = context.cancellation;
            if (cancellation?.turnId === turnId) {
              yield* Deferred.await(cancellation.completion).pipe(Effect.result);
            }
            if (context.promptAdmission === promptAdmission) {
              context.promptAdmission = undefined;
            }
            return yield* Effect.interrupt;
          }
          promptAdmission.accepted = true;
          yield* Deferred.succeed(promptAdmission.acceptance, undefined).pipe(Effect.ignore);
          if (
            context.promptAdmission === promptAdmission &&
            context.activeTurnId === turnId &&
            context.promptGeneration === promptAdmission.generation &&
            promptAdmission.messageObserved
          ) {
            context.awaitingBusyAfterInterruption = false;
            const idle = promptAdmission.idleDuringAdmission;
            if (idle && !promptAdmission.idleObservedAfterMessage) {
              yield* schedulePromptAdmissionRecovery(context, idle.raw);
            } else {
              context.promptAdmission = undefined;
            }
            if (idle && promptAdmission.idleObservedAfterMessage) {
              yield* scheduleIdleReconciliation(context, turnId, idle.raw);
            }
          } else {
            yield* schedulePromptAdmissionRecovery(context, promptAdmission.recoveryRaw);
          }

          const stopped = yield* Ref.get(context.stopped);
          const finalCancellation = context.cancellation;
          if (
            stopped ||
            sessions.get(input.threadId) !== context ||
            promptAdmission.cancelled ||
            context.activeTurnId !== turnId ||
            context.promptGeneration !== promptAdmission.generation ||
            finalCancellation?.turnId === turnId
          ) {
            if (finalCancellation?.turnId === turnId) {
              yield* Deferred.await(finalCancellation.completion).pipe(Effect.result);
            }
            if (context.promptAdmission === promptAdmission) {
              context.promptAdmission = undefined;
            }
            return yield* Effect.interrupt;
          }

          return {
            threadId: input.threadId,
            turnId,
            // Re-surface the durable cursor on every turn so the persisted binding
            // is refreshed alongside last-seen/runtime state (mirrors Grok/Codex).
            ...(context.session.resumeCursor !== undefined
              ? { resumeCursor: context.session.resumeCursor }
              : {}),
          };
        }),
      );
    });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const activeTurnId = context.activeTurnId;
        if (turnId !== undefined && activeTurnId !== turnId) {
          return;
        }
        const interruptedTurnId = turnId ?? activeTurnId;
        yield* cancelIdleReconciliation(context);
        if (interruptedTurnId && context.interruptedTurnId === interruptedTurnId) {
          return;
        }
        const existingCancellation = context.cancellation;
        if (existingCancellation !== undefined) {
          return yield* Deferred.await(existingCancellation.completion);
        }
        const cancellation: OpenCodeCancellation = {
          turnId: interruptedTurnId,
          acknowledgment: Deferred.makeUnsafe<void>(),
          completion: Deferred.makeUnsafe<void, ProviderAdapterRequestError>(),
        };
        context.cancellation = cancellation;
        const promptAdmission = context.promptAdmission;
        if (promptAdmission !== undefined && promptAdmission.turnId === interruptedTurnId) {
          promptAdmission.cancelled = true;
          if (promptAdmission.promptFiber) {
            yield* Fiber.interrupt(promptAdmission.promptFiber);
          }
          yield* Deferred.await(promptAdmission.submissionSettled);
        }

        const parentAbortOutcome = yield* Effect.raceFirst(
          runOpenCodeSdk("session.abort", (signal) =>
            context.client.session.abort({ sessionID: context.openCodeSessionId }, { signal }),
          ).pipe(
            Effect.asVoid,
            Effect.timeout("10 seconds"),
            Effect.catchTags({
              OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
              TimeoutError: (cause) =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.abort",
                    detail: "OpenCode session abort did not complete within 10 seconds.",
                    cause,
                  }),
                ),
            }),
            Effect.exit,
            Effect.map((exit) => ({ source: "request" as const, exit })),
          ),
          Effect.raceFirst(
            Deferred.await(cancellation.acknowledgment).pipe(
              Effect.map(() => ({ source: "acknowledgment" as const })),
            ),
            Deferred.await(cancellation.completion).pipe(
              Effect.exit,
              Effect.map((exit) => ({ source: "completion" as const, exit })),
            ),
          ),
        );
        if (parentAbortOutcome.source === "completion") {
          return Exit.isFailure(parentAbortOutcome.exit)
            ? yield* Effect.failCause(parentAbortOutcome.exit.cause)
            : undefined;
        }
        const parentAbortExit =
          parentAbortOutcome.source === "request" ? parentAbortOutcome.exit : Exit.void;

        const descendantAbortOutcome = yield* Effect.raceFirst(
          abortOpenCodeDescendants(context).pipe(
            Effect.timeout("10 seconds"),
            Effect.catchTags({
              OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
              TimeoutError: (cause) =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.abort",
                    detail: "OpenCode child session cleanup did not complete within 10 seconds.",
                    cause,
                  }),
                ),
            }),
            Effect.exit,
            Effect.map((exit) => ({ source: "request" as const, exit })),
          ),
          Deferred.await(cancellation.completion).pipe(
            Effect.exit,
            Effect.map((exit) => ({ source: "completion" as const, exit })),
          ),
        );
        if (descendantAbortOutcome.source === "completion") {
          return Exit.isFailure(descendantAbortOutcome.exit)
            ? yield* Effect.failCause(descendantAbortOutcome.exit.cause)
            : undefined;
        }

        const parentAbortFailed = Exit.isFailure(parentAbortExit) && !cancellation.acknowledged;
        const failedExit = parentAbortFailed
          ? parentAbortExit
          : Exit.isFailure(descendantAbortOutcome.exit)
            ? descendantAbortOutcome.exit
            : undefined;
        if (failedExit !== undefined && Exit.isFailure(failedExit)) {
          if (context.cancellation === cancellation) {
            context.cancellation = undefined;
            if (
              parentAbortFailed &&
              cancellation.turnId !== undefined &&
              cancellation.deferredIdleEvent
            ) {
              yield* scheduleIdleReconciliation(
                context,
                cancellation.turnId,
                cancellation.deferredIdleEvent,
              );
            }
          }
          yield* Deferred.done(cancellation.completion, failedExit).pipe(Effect.ignore);
          return yield* Effect.failCause(failedExit.cause);
        }

        if (context.cancellation === cancellation) {
          // Provider events can settle the parent turn while descendant cleanup is still in flight.
          // Cleanup still owns stopping any direct tasks that remain active.
          for (const activation of context.taskActivationsByCallId.values()) {
            if (!activation.terminal) {
              yield* completeTaskActivation(context, activation, "stopped", "Interrupted by user.");
            }
          }

          if (cancellation.turnSettled) {
            context.cancellation = undefined;
          } else {
            if (cancellation.turnId !== undefined) {
              yield* interruptOpenCodeTurn(context, cancellation.turnId);
            } else {
              context.cancellation = undefined;
              context.reconcileIdleStatus = true;
            }
          }
        }
        yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = yield* ensureSessionContext(sessions, threadId);
      if (!context.pendingPermissions.has(requestId)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("permission.reply", () =>
        context.client.permission.reply({
          requestID: requestId,
          reply: toOpenCodePermissionReply(decision),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = yield* ensureSessionContext(sessions, threadId);
      const request = context.pendingQuestions.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("question.reply", () =>
        context.client.question.reply({
          requestID: requestId,
          answers: toOpenCodeQuestionAnswers(request, answers),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopOpenCodeContext(context);
        deleteContextIfCurrent(context);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
        deleteSessionSequenceIfInactive(threadId);
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readTaskTranscript = Effect.fn("readTaskTranscript")(function* (input: {
      readonly threadId: ThreadId;
      readonly taskId: RuntimeTaskId;
      readonly cursor: string | null;
      readonly parentResumeCursor: unknown;
      readonly cwd: string;
    }) {
      const parentResume = parseOpenCodeResume(input.parentResumeCursor);
      const activeContext = sessions.get(input.threadId);
      const parentSessionId = activeContext?.openCodeSessionId ?? parentResume?.sessionId;
      if (!parentSessionId) {
        return yield* new ProviderTaskTranscriptError({
          threadId: input.threadId,
          taskId: input.taskId,
          reason: "unavailable",
        });
      }

      function boundedTranscriptText(value: string): {
        readonly text: string;
        readonly truncated: boolean;
      } {
        if (value.length <= PROVIDER_TASK_TRANSCRIPT_PART_MAX_CHARS) {
          return { text: value, truncated: false };
        }
        return {
          text: value.slice(0, PROVIDER_TASK_TRANSCRIPT_PART_MAX_CHARS),
          truncated: true,
        };
      }

      function serializeTranscriptValue(value: unknown):
        | {
            readonly text: string;
            readonly truncated: boolean;
          }
        | undefined {
        if (value === undefined) {
          return undefined;
        }
        try {
          const encoded = JSON.stringify(value, null, 2);
          return encoded === undefined
            ? { text: "This tool input could not be serialized.", truncated: false }
            : boundedTranscriptText(encoded);
        } catch {
          // Provider tool inputs should be JSON values; keep the malformed entry visible.
          return { text: "This tool input could not be serialized.", truncated: false };
        }
      }

      function normalizePart(part: Part): ProviderTaskTranscriptPart {
        if (part.type === "text" || part.type === "reasoning") {
          const content =
            typeof part.text === "string"
              ? boundedTranscriptText(part.text)
              : { text: "This provider text could not be read.", truncated: false };
          return {
            id: part.id,
            type: part.type,
            text: content.text,
            truncated: content.truncated,
          };
        }
        if (part.type === "tool") {
          const inputValue = serializeTranscriptValue(part.state.input);
          const outputValue =
            part.state.status === "completed"
              ? typeof part.state.output === "string"
                ? boundedTranscriptText(part.state.output)
                : { text: "This tool output could not be read.", truncated: false }
              : undefined;
          const errorValue =
            part.state.status === "error"
              ? typeof part.state.error === "string"
                ? boundedTranscriptText(part.state.error)
                : { text: "This tool error could not be read.", truncated: false }
              : undefined;
          return {
            id: part.id,
            type: "tool",
            toolCallId: part.callID,
            name: part.tool,
            status: part.state.status === "error" ? "failed" : part.state.status,
            ...(inputValue ? { input: inputValue.text } : {}),
            ...(outputValue ? { output: outputValue.text } : {}),
            ...(errorValue ? { error: errorValue.text } : {}),
            inputTruncated: inputValue?.truncated ?? false,
            outputTruncated: outputValue?.truncated ?? false,
            errorTruncated: errorValue?.truncated ?? false,
          };
        }

        return {
          id: part.id,
          type: "notice",
          label: `OpenCode ${part.type}`,
          detail: "This provider event is not rendered in the transcript.",
          truncated: false,
        };
      }

      const readFromClient = Effect.fn("readTaskTranscriptFromClient")(function* (
        client: OpencodeClient,
      ) {
        const child = yield* runOpenCodeSdk("session.get", () =>
          client.session.get({ sessionID: input.taskId }),
        ).pipe(
          Effect.catchIf(
            (cause) => isOpenCodeNotFound(cause),
            () =>
              new ProviderTaskTranscriptError({
                threadId: input.threadId,
                taskId: input.taskId,
                reason: "not-found",
              }),
          ),
        );
        if (!child.data || child.data.parentID !== parentSessionId) {
          return yield* new ProviderTaskTranscriptError({
            threadId: input.threadId,
            taskId: input.taskId,
            reason: "not-found",
          });
        }

        const result = yield* runOpenCodeSdk("session.messages", () =>
          client.session.messages({
            sessionID: input.taskId,
            limit: PROVIDER_TASK_TRANSCRIPT_PAGE_SIZE,
            ...(input.cursor ? { before: input.cursor } : {}),
          }),
        );
        if (!Array.isArray(result.data)) {
          return yield* new OpenCodeRuntimeError({
            operation: "session.messages",
            detail: "OpenCode session.messages returned no message list.",
          });
        }

        const messages: Array<ProviderTaskTranscriptMessage> = result.data.map((entry) => ({
          id: entry.info.id,
          role: entry.info.role,
          ...(typeof entry.info.time?.created === "number"
            ? { createdAt: isoFromEpochMs(entry.info.time.created) }
            : {}),
          parts: (entry.parts as Array<Part>).map(normalizePart),
        }));
        return {
          provider: PROVIDER,
          taskId: input.taskId,
          messages,
          nextCursor: result.response.headers.get("X-Next-Cursor")?.trim() || null,
        };
      });

      if (activeContext) {
        return yield* readFromClient(activeContext.client).pipe(
          Effect.mapError((cause) =>
            isProviderTaskTranscriptError(cause) ? cause : toRequestError(cause),
          ),
        );
      }

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* openCodeRuntime.connectToOpenCodeServer({
            binaryPath: openCodeSettings.binaryPath,
            directory: input.cwd,
            serverUrl: openCodeSettings.serverUrl,
            ...(options?.environment ? { environment: options.environment } : {}),
          });
          const client = openCodeRuntime.createOpenCodeSdkClient({
            baseUrl: server.url,
            directory: input.cwd,
            ...(server.external && openCodeSettings.serverPassword
              ? { serverPassword: openCodeSettings.serverPassword }
              : {}),
          });
          return yield* readFromClient(client);
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isProviderTaskTranscriptError(cause) ? cause : toRequestError(cause),
        ),
      );
    });

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const turns: Array<OpenCodeTurnSnapshot> = [];
        for (const entry of messages.data ?? []) {
          if (entry.info.role === "assistant") {
            turns.push({
              id: TurnId.make(entry.info.id),
              items: [entry.info, ...entry.parts],
            });
          }
        }

        return {
          threadId,
          turns,
        };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const assistantMessages = (messages.data ?? []).filter(
          (entry) => entry.info.role === "assistant",
        );
        const targetIndex = assistantMessages.length - numTurns - 1;
        const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
        yield* runOpenCodeSdk("session.revert", () =>
          context.client.session.revert({
            sessionID: context.openCodeSessionId,
            ...(target ? { messageID: target.info.id } : {}),
          }),
        ).pipe(Effect.mapError(toRequestError));

        return yield* readThread(threadId);
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `stopOpenCodeContext` is typed as never-failing — SDK aborts are
        // already `Effect.ignore`'d inside it. `ignoreCause` here also
        // swallows defects from throwing finalizers so one bad close can't
        // interrupt the sibling fibers. Same pattern as the layer finalizer.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        sessionSequenceByThreadId.clear();
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      taskTranscript: { kind: "supported", read: readTaskTranscript },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
