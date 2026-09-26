# Validation

Updated September 26, 2026. Original SDK and standalone widget checks were performed September 25; Studio checks were performed September 26.

## Automated checks

- TypeScript build and type check pass.
- All 81 offline tests pass on Node 26.0.0, including 22 Studio integration tests using real workerd and D1 with mocked Gumloop HTTP. The original 31 SDK and developer-demo tests also passed on Node 22.22.3.
- Tests cover authentication and team scope, API routes, structured errors, approval requests, fragmented SSE and UTF-8 parsing, cursor recovery, and cancellation.
- A local HTTP integration test verifies that disconnecting the browser closes the upstream stream without replaying the message or cancelling the task. Reconnect sends a GET with the original cursor.
- Demo tests check origin and Host restrictions, request limits, streaming relay, and approval payloads.

Run with `npm test`, `npm run typecheck`, and `npm run studio:typecheck`. These checks do not call Gumloop or consume credits.

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

## Relay Studio checks

The Studio type check and Wrangler deployment dry run pass. The original nine workerd/D1 integration tests cover owner authentication and CSRF, encrypted credentials, account rotation, safe agent edits, optimistic versions, draft/publication separation, expiring previews, visitor ownership, response filtering, persistent quotas, and concurrent conversation reservations.

Live API checks against both local Wrangler and the deployed Cloudflare Worker verified:

- The connected account's four agents load, and a widget can be created and published using the dedicated Northstar demo agent.
- Saving a draft leaves the public design unchanged; a stale version is rejected.
- Preview configurations stay private to the studio origin.
- A second visitor cannot retrieve another visitor's conversation.
- Real incremental responses include the configured photography policies and end in a confirmed completed state.

Chrome checks verified password login, the appearance editor, theme and color updates without clearing the current conversation, a 390-pixel preview, and a separate preview tab that includes unsaved cosmetic changes. A description edit was saved to the dedicated Gumloop demo agent and then restored. The install panel generated the correct snippet. No horizontal overflow or JavaScript errors were observed.

The deployed widget was also embedded on a separate website origin in a fresh Chrome profile. It streamed a real answer, restored the same conversation after reload with exactly one message POST, exposed no Gumloop API key in browser requests, and fit a 390-pixel viewport.

Live checks consume Gumloop credits and are intentionally separate from `npm test`. They used the dedicated fictional demo agent rather than modifying other agents in the account.

## Bring-your-own-account checks

Additional real workerd/D1 tests cover:

- Signup validates Gumloop credentials before creating a workspace; only access-code and session-token hashes are persisted.
- Returning users can sign in with their generated code; the original owner password and existing widgets survive migration.
- Cross-workspace widget reads, edits, publishing, and previews are denied.
- Public chat selects credentials from the stored widget's workspace, even when another workspace has the same agent ID.
- Swapping encrypted credentials between workspaces fails authenticated decryption; guests cannot downgrade to the old owner encryption format.
- Disconnect deletes credentials and public contexts while retaining drafts; guest requests never fall back to the owner's environment key.
- Credential updates cannot change the bound Gumloop account or undo a disconnect committed during upstream validation.
- Visitor and preview requests started before disconnect cannot mint usable tokens after reconnect.
- Message quotas and active-task reservations are independent between workspaces.

Chrome exercised the complete flow against both local Wrangler and the deployed Cloudflare Worker with real Gumloop credentials: create a workspace, acknowledge its access code, create a widget, chat in preview, publish, update the key, sign out, sign back in with the saved code, and disconnect. Credentials cleared from the forms and did not enter localStorage. The original workspace's widgets and connection remained available. No JavaScript errors or horizontal overflow were observed at the tested desktop and mobile sizes.

## Current limits

- OAuth and team-key header behavior are covered by offline tests; live tests used a personal API key.
- Listed-choice human input is verified. The wire format for a custom Other answer is not documented sufficiently to implement confidently; the demo explains this limitation.
- Other approval question types have an advanced JSON fallback in the developer playground and are not all live tested. The public widget only offers supported human-input choices.
- During recovery, the demo refreshes saved transcript snapshots rather than appending replayed deltas to existing text. Normal new-message replies stream incrementally.
- The developer demo remains a local, single-user application. The standalone Node widget is a single-process prototype. Relay Studio runs on Cloudflare with D1 persistence and separate private workspaces; it does not implement verified customer identities, email account recovery, or billing.
- The client covers Agents and sessions, not the full Gumloop API.

## Optional live smoke script

`scripts/live-smoke.mjs` starts real tasks and consumes credits. Set `GUMLOOP_TEST_AGENT_ID` to a dedicated test agent with no connected apps, then run:

```sh
npm run build
GUMLOOP_TEST_AGENT_ID=your_test_agent_id node scripts/live-smoke.mjs
```

An optional `GUMLOOP_TEST_APPROVAL_SESSION_ID` designates a synthetic pending human-input session belonging to that agent. The script chooses the first offered option and checks continuation. It never creates an agent or configures connectors. Results are saved in ignored `.local/live-results.json`.
