# Protocol verification notes

Checked against Gumloop's public documentation and Python SDK on 2026-09-25. This is an unofficial implementation. These notes distinguish documented behavior from behavior that still needs live verification.

## Hosts and authentication

- JSON REST operations use `https://api.gumloop.com/api/v1`.
- Agent event streams use `https://ws.gumloop.com/api/v1`. Setting `stream: true` on the REST host produces a 400 rather than a stream.
- Both accept `Authorization: Bearer <credential>`. Personal API keys additionally require `x-auth-key: <user ID>`; OAuth access tokens do not require that header.
- The Python SDK adds configured `team_id` to REST query parameters. Its streaming path currently does not apply the same helper; this client should consistently forward configured team scope on both paths. That difference alone is not evidence of a live Python SDK bug.

Sources: [create session](https://docs.gumloop.com/api-reference/sessions/create-session), [send message](https://docs.gumloop.com/api-reference/sessions/send-message), [Python HTTP transport](https://github.com/gumloop/gumloop-py/blob/main/src/gumloop/_http.py).

## Session operations

| Operation | Method and path | Behavior |
| --- | --- | --- |
| Create | `POST /agents/{agent_id}/sessions` | Omit input for an idle stub (201). Supply input to enqueue work (202, processing or queued). Optional caller-supplied `session_id`; duplicate IDs return 409. |
| Retrieve | `GET /sessions/{session_id}` | Includes transcript, current state, usage, and pending approvals. |
| Send | `POST /sessions/{session_id}/messages` | Required input. Accepts idle/completed/failed/approval_required sessions; processing or queued returns 409. |
| Stream create/send | Same POST paths on streaming host | Add `stream: true`; incremental SSE response. |
| Resume stream | `GET /sessions/{session_id}?stream=true&last_cursor=...` on streaming host | Python SDK implements this without sending another user message. |
| Cancel | `POST /sessions/{session_id}/cancel` | Processing/queued becomes failed; completed/failed stays as-is. Response only meaningfully populates id, agent_id, state. |
| Resolve approvals | `POST /sessions/{session_id}/approvals` | Resolves pending asks and can restart the run. |

Cancellation is separate from aborting a local HTTP request. The latter does not guarantee the remote task stopped. Never automatically retry message-creating POST requests after ambiguous failures. A known session ID and a GET let callers inspect state before deciding what to do next.

The cancel response can contain empty/default transcript fields. A chat UI must not replace its transcript with these defaults. Retrieve the full session afterward.

Documented states are `idle`, `queued`, `processing`, `completed`, `failed`, and `approval_required`. Treat unknown future states conservatively. Approval required is a pause requiring a decision, not successful completion.

Sources: [create](https://docs.gumloop.com/api-reference/sessions/create-session), [retrieve](https://docs.gumloop.com/api-reference/sessions/retrieve-session), [send](https://docs.gumloop.com/api-reference/sessions/send-message), [cancel](https://docs.gumloop.com/api-reference/sessions/cancel-session), [Python sessions resource](https://github.com/gumloop/gumloop-py/blob/main/src/gumloop/resources/sessions.py).

## Approvals

Retrieve session exposes `pending_approvals`. Each item can contain:

```ts
{
  action_request_id: string | null;
  type: string; // examples: tool_approval, human_input
  title?: string | null;
  reason?: string | null;
  recipient_user_id?: string | null;
  tool_name?: string | null;
  server_label?: string | null;
  display_fields?: string[][] | null;
  questions?: Record<string, unknown>[] | null;
}
```

The public schema does not specify the inner shape of `questions`; do not invent a guaranteed form schema. Preserve these objects for consumers and use a transparent JSON input if necessary in a minimal demo.

Resolution request:

```json
{
  "approval_responses": [
    {
      "action_request_id": "areq_example",
      "action": "accept",
      "reason": "Reviewed by the user",
      "response": { "values": { "email_subject": "Pipeline review" } }
    }
  ]
}
```

`action` is `accept` or `reject`; `reason` and `response` are optional. Values answer human-input questions by name. A batch must contain 1–20 distinct action IDs. Resolutions are processed in order; the agent resumes after its pending asks are answered. The response contains `session`, per-item `results` (including outcome), and an optional nullable `stream_cursor` for resuming output.

Sending a normal follow-up message to an approval-required session starts a new turn but does not answer the ask. Sending `approval_responses` to the ordinary REST messages endpoint is rejected. Use the dedicated endpoint.

The inspected Python SDK does not yet expose the approvals operation; the public REST documentation is the source for this method.

Sources: [resolve approvals](https://docs.gumloop.com/api-reference/sessions/resolve-approvals), [retrieve session](https://docs.gumloop.com/api-reference/sessions/retrieve-session), [send message](https://docs.gumloop.com/api-reference/sessions/send-message).

## Event streams and recovery

Python's public `StreamEvent` is intentionally permissive: fields include `type`, `data`, `stream_cursor`, `final`, `finishReason`, `error`, and `errorMessage`, with extra payload fields preserved. The public Python test suite includes a final event with `finishReason: "not_resumable"`; that signals inability to resume, not proof the agent completed successfully. Retrieve session to determine the authoritative state.

The public pages and SDK tests reviewed do not specify a complete text-delta schema. A UI must use verified live event shapes and preserve unfamiliar events rather than silently discarding them. Any later live observations should be recorded separately from the documentation guarantees.

Use streaming UTF-8 decoding and an actual SSE parser: byte boundaries need not align with characters, lines, events, or JSON tokens. Support CRLF/LF/CR, multiline data, comments, and `[DONE]`. Preserve transport metadata separately from payload data. A transport ending without a final event must not automatically be rendered as successful completion.

Reconnection should use the last observed `stream_cursor` with the GET resume operation; never recreate the session or resend a message to recover a dropped connection. Cursor retention duration and replay boundary semantics are not documented in the sources reviewed.

Sources: [Python event type](https://github.com/gumloop/gumloop-py/blob/main/src/gumloop/types.py), [Python stream tests](https://github.com/gumloop/gumloop-py/blob/main/tests/sdk/test_sessions.py), [Python HTTP transport](https://github.com/gumloop/gumloop-py/blob/main/src/gumloop/_http.py).

### Live observations on the test account

A dedicated synthetic agent run on 2026-09-25 produced these event shapes. They are observed behavior, not a complete published schema:

| Event type | Observed payload fields |
| --- | --- |
| `interaction-ready` | `interaction_id`, `stream_cursor` |
| `text-start` | `id` (message ID) |
| `text-delta` | `id`, `delta` (text), `stream_cursor` |
| `text-end` | End of one text block |
| `finish` | `finishReason`, `final`, `queuedContinuation` |

The run emitted `finish` twice: first with `final: false`, then with `final: true`. A first finish event must not prematurely end processing. Retrieving the completed conversation returned assistant text in `messages[].parts` while `messages[].content` was null. Both content representations need to be handled by a chat UI. No account IDs or credentials are included here.

A completed stream resume returned HTTP 200 with only a final `finish` event carrying `finishReason: "not_resumable"`. Another test run paused for human input but still ended its stream with `finishReason: "stop"` and `final: true`; the retrieved session state was `approval_required`. This confirms that stream closure and a stop finish reason cannot alone distinguish completion from a pause.

The observed human-input question used `type: "toggle_group"`, an options list, and a custom option. An unlisted plain string answer was rejected with `invalid_human_input_option`; arbitrary free text must not be treated as a valid listed choice. The public docs explain the Other option's UI but do not specify its custom-answer wire representation. The demo renders known choice lists and leaves custom answers to Gumloop. This is one observed question format, not an exhaustive question schema.

A second human-input test selected a listed option by submitting `response.values` with the question name mapped to that option's value. The API returned an `accepted` outcome, a processing session, and a resume cursor. Resuming with GET then yielded the completed answer. This verifies the listed-choice approval path through the client.

Cancellation showed eventual consistency in one live test: the cancel response and an immediate GET reported completed, while a later GET reported failed with a partial assistant message and an error part. The demo should acknowledge a stop request without promising an immediate terminal transition, and reconcile the session after a short delay. The documented state transition above does not describe this observed timing nuance.

The demo reconnects the event stream without resending a message. Because retrieved transcripts do not include a cursor-to-text offset, it uses periodically refreshed session snapshots for text during recovery. It does not append replayed deltas into an already populated transcript, which could duplicate text. Normal new-message streaming remains incremental.

## Error fidelity

Gumloop's Python client supports multiple error envelopes: nested `{error: {code, message, details}}`, flat `{error: "code", message, metadata}`, OAuth `{error, error_description}`, and non-JSON HTTP bodies. Preserve status and response body, and select a useful message without hiding the machine-readable error code. A successful HTTP stream can still carry an error event; HTTP status alone does not establish task success.

Source: [Python error mapping](https://github.com/gumloop/gumloop-py/blob/main/src/gumloop/errors.py).
