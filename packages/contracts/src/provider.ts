import * as Schema from "effect/Schema";
import { RuntimeTaskId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

export const ProviderUploadFeedbackInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderUploadFeedbackInput = typeof ProviderUploadFeedbackInput.Type;

export const ProviderUploadFeedbackResult = Schema.Struct({
  feedbackId: TrimmedNonEmptyString,
});
export type ProviderUploadFeedbackResult = typeof ProviderUploadFeedbackResult.Type;

export class ProviderUploadFeedbackError extends Schema.TaggedErrorClass<ProviderUploadFeedbackError>()(
  "ProviderUploadFeedbackError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to upload feedback for thread ${this.threadId}.`;
  }
}

export const PROVIDER_TASK_TRANSCRIPT_PAGE_SIZE = 50;
export const PROVIDER_TASK_TRANSCRIPT_PART_MAX_CHARS = 50_000;

const ProviderTaskTranscriptContent = Schema.String.check(
  Schema.isMaxLength(PROVIDER_TASK_TRANSCRIPT_PART_MAX_CHARS),
);

export const ProviderTaskTranscriptTextPart = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literal("text"),
  text: ProviderTaskTranscriptContent,
  truncated: Schema.Boolean,
});
export type ProviderTaskTranscriptTextPart = typeof ProviderTaskTranscriptTextPart.Type;

export const ProviderTaskTranscriptReasoningPart = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literal("reasoning"),
  text: ProviderTaskTranscriptContent,
  truncated: Schema.Boolean,
});
export type ProviderTaskTranscriptReasoningPart = typeof ProviderTaskTranscriptReasoningPart.Type;

export const ProviderTaskTranscriptToolPart = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literal("tool"),
  toolCallId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "running", "completed", "failed"]),
  input: Schema.optional(ProviderTaskTranscriptContent),
  output: Schema.optional(ProviderTaskTranscriptContent),
  error: Schema.optional(ProviderTaskTranscriptContent),
  inputTruncated: Schema.Boolean,
  outputTruncated: Schema.Boolean,
  errorTruncated: Schema.Boolean,
});
export type ProviderTaskTranscriptToolPart = typeof ProviderTaskTranscriptToolPart.Type;

export const ProviderTaskTranscriptNoticePart = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: Schema.Literal("notice"),
  label: TrimmedNonEmptyString,
  detail: Schema.optional(ProviderTaskTranscriptContent),
  truncated: Schema.Boolean,
});
export type ProviderTaskTranscriptNoticePart = typeof ProviderTaskTranscriptNoticePart.Type;

export const ProviderTaskTranscriptPart = Schema.Union([
  ProviderTaskTranscriptTextPart,
  ProviderTaskTranscriptReasoningPart,
  ProviderTaskTranscriptToolPart,
  ProviderTaskTranscriptNoticePart,
]);
export type ProviderTaskTranscriptPart = typeof ProviderTaskTranscriptPart.Type;

export const ProviderTaskTranscriptMessage = Schema.Struct({
  id: TrimmedNonEmptyString,
  role: Schema.Literals(["user", "assistant"]),
  createdAt: Schema.optional(IsoDateTime),
  parts: Schema.Array(ProviderTaskTranscriptPart),
});
export type ProviderTaskTranscriptMessage = typeof ProviderTaskTranscriptMessage.Type;

export const ProviderTaskTranscriptInput = Schema.Struct({
  threadId: ThreadId,
  taskId: RuntimeTaskId,
  cursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProviderTaskTranscriptInput = typeof ProviderTaskTranscriptInput.Type;

export const ProviderTaskTranscriptPage = Schema.Struct({
  provider: ProviderDriverKind,
  taskId: RuntimeTaskId,
  messages: Schema.Array(ProviderTaskTranscriptMessage).check(
    Schema.isMaxLength(PROVIDER_TASK_TRANSCRIPT_PAGE_SIZE),
  ),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProviderTaskTranscriptPage = typeof ProviderTaskTranscriptPage.Type;

const PROVIDER_TASK_TRANSCRIPT_ERROR_MESSAGES = {
  unsupported: "This provider does not support subagent transcripts.",
  "not-found": "This subagent transcript was not found in the thread.",
  unavailable: "This subagent transcript is no longer available from the provider.",
} as const;

export class ProviderTaskTranscriptError extends Schema.TaggedErrorClass<ProviderTaskTranscriptError>()(
  "ProviderTaskTranscriptError",
  {
    threadId: ThreadId,
    taskId: RuntimeTaskId,
    reason: Schema.Literals(["unsupported", "not-found", "unavailable"]),
  },
) {
  override get message(): string {
    return PROVIDER_TASK_TRANSCRIPT_ERROR_MESSAGES[this.reason];
  }
}

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
