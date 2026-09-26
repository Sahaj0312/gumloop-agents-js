# Validation

Verified on September 25, 2026.

## Automated checks

- TypeScript build and type check pass.
- All 52 offline tests pass on Node 26.0.0. The original 31 SDK and developer-demo tests also passed on Node 22.22.3.
- Tests cover authentication and team scope, API routes, structured errors, approval requests, fragmented SSE and UTF-8 parsing, cursor recovery, and cancellation.
- A local HTTP integration test verifies that disconnecting the browser closes the upstream stream without replaying the message or cancelling the task. Reconnect sends a GET with the original cursor.
- Demo tests check origin and Host restrictions, request limits, streaming relay, and approval payloads.

Run with `npm test` and `npm run typecheck`. These checks do not call Gumloop or consume credits.

## Live Gumloop checks

Used a dedicated test agent with no connected external apps. Gumloop supplies default built-in abilities even when creation requests specify an empty tools array. Tests used text responses and the human-input ability.

Verified:

- List agents and retrieve the dedicated test agent.
- Start a session and receive incremental text events.
- Continue the same conversation and retain its context.
- Disconnect during processing and resume text through the GET cursor endpoint, without another user message.
- Explicit server-side cancellation; a later retrieval showed failed with partial output. Immediate cancellation snapshots briefly reported completed, so the demo reconciles after a delay.
- Select a listed human-input option; the API accepted it, returned a resume cursor, and the agent continued to a completed answer.
- Completed-stream recovery can return `not_resumable`; retrieve the saved conversation instead of restarting work.

## Browser checks

Headless Chrome with a separate temporary browser profile exercised the real local demo against Gumloop:

1. Select the dedicated test agent, send a message, and receive its answer.
2. Reload and restore the same conversation without duplicate assistant messages.
3. Request a human-input choice, select an option in the form, approve, and receive the continued answer.
4. Inspect desktop and 390-pixel mobile layouts; no horizontal overflow or browser JavaScript errors observed.

The reviewer also exercised approval and recovery behavior in Chrome against a mock SDK.

## Embeddable widget checks

The additional 21 offline tests cover visitor ownership across every conversation action, exact origin and widget binding, public transcript filtering, human-answer validation, blocked tool approvals, rate limits, persisted token hashes, expiration, concurrent sends, and disconnect behavior. One HTTP integration test uses the real SDK against a mock Gumloop API.

Chrome exercised the widget on a separate website origin against the real Gumloop API, using a dedicated fictional photography FAQ agent:

- Received the agent's answer about a 20-minute session and a $35 sitting fee.
- Minimized, reopened, and reloaded the conversation with exactly one message POST.
- Confirmed a second browser visitor received 404 when requesting the first visitor's conversation.
- Inspected desktop and 390-pixel mobile layouts, with no horizontal overflow or JavaScript errors.

A separate Chrome check against a mocked Gumloop client verified supported human-input forms, approval continuation, New chat, and style isolation. Widget-specific approval behavior was not separately exercised against the live API; the underlying SDK and developer-demo approval flow was.

## Current limits

- OAuth and team-key header behavior are covered by offline tests; live tests used a personal API key.
- Listed-choice human input is verified. The wire format for a custom Other answer is not documented sufficiently to implement confidently; the demo explains this limitation.
- Other approval question types have an advanced JSON fallback in the developer playground and are not all live tested. The public widget only offers supported human-input choices.
- During recovery, the demo refreshes saved transcript snapshots rather than appending replayed deltas to existing text. Normal new-message replies stream incrementally.
- The developer demo is a local, single-user application. The public widget separately provides anonymous visitor conversation ownership, but is a single-process prototype without customer identity verification or hosted SaaS management.
- The client covers Agents and sessions, not the full Gumloop API.

## Optional live smoke script

`scripts/live-smoke.mjs` starts real tasks and consumes credits. Set `GUMLOOP_TEST_AGENT_ID` to a dedicated test agent with no connected apps, then run:

```sh
npm run build
GUMLOOP_TEST_AGENT_ID=your_test_agent_id node scripts/live-smoke.mjs
```

An optional `GUMLOOP_TEST_APPROVAL_SESSION_ID` designates a synthetic pending human-input session belonging to that agent. The script chooses the first offered option and checks continuation. It never creates an agent or configures connectors. Results are saved in ignored `.local/live-results.json`.
