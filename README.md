# Gumloop Agents for TypeScript

An **unofficial** Node.js client for Gumloop's current Agents API, with a local chat demo. Written as a focused contribution prototype; not affiliated with or endorsed by Gumloop. Not published to npm.

Gumloop's public JavaScript package currently exposes legacy workflow operations. Its current Agents API supports conversations, streaming, cancellations, and approvals. This project makes those operations available from TypeScript while preserving the underlying API events.

## Run the chat demo

Requires Node.js 20.12 or newer and a Gumloop account with API access.

```sh
npm install
cp .env.example .env
# Fill in your Gumloop credentials in .env.
npm run demo
```

Open the local URL printed by the server. Pick an agent and send a message. Credentials stay on the Node server. The demo binds to your local machine; it is not a hosted, multi-user application.

## Use the SDK

```ts
import { Gumloop } from './dist/index.js';

const client = new Gumloop({
  apiKey: process.env.GUMLOOP_API_KEY,
  userId: process.env.GUMLOOP_USER_ID,
});

const { agents } = await client.agents.list();
if (!agents.length) throw new Error('Create an agent in Gumloop first.');

const sessionId = `sess_${crypto.randomUUID()}`;
for await (const event of client.sessions.stream(agents[0].id, {
  session_id: sessionId,
  input: 'Say hello in one sentence.',
})) {
  if (event.type === 'text-delta' && typeof event.delta === 'string') {
    process.stdout.write(event.delta);
  }
}

// Stream EOF is not proof that the agent completed successfully.
const { session } = await client.sessions.retrieve(sessionId);
console.log('\nSession state:', session.state);
```

Pass an OAuth `accessToken` instead of an API key when appropriate. Personal API keys need `userId`; team integrations can supply `teamId`. Keep this client and its credentials on your application's backend.

## Execution behavior

- Starting and continuing a session use POST requests. The client never automatically retries these: a timed-out request may already have started work.
- Streaming uses Gumloop's streaming host. Normal reads and non-streaming requests use its REST API host.
- Events keep their original payloads, including stream cursors and unknown event types.
- Passing an `AbortSignal` disconnects your HTTP request. Explicit `sessions.cancel(id)` stops the server-side task. These are separate actions.
- A finished stream can represent completion, failure, or a pause for approval. Retrieve the session to inspect its actual state.
- A caller-supplied session ID lets an application look up an uncertain creation instead of blindly starting another task. Duplicate session creation is reported as an API conflict.

See [protocol notes](docs/protocol-notes.md) and [validation](docs/validation.md) for evidence and current limits.

## Development

```sh
npm test
npm run typecheck
```

The test suite uses local fake transports/servers and does not spend Gumloop credits. Live checks are separate and use a dedicated agent with no connected apps.

## Scope

This is a focused Agents/session client, not full parity with Gumloop's Python SDK. It does not implement legacy workflows, host agent execution, or provide an authentication system for public websites. Production embedding needs your own user authentication and authorization to decide who can invoke which agent and access which conversation.

## API references

- [Current Python SDK](https://docs.gumloop.com/api-reference/sdk/python)
- [Create and stream sessions](https://docs.gumloop.com/api-reference/sessions/create-session)
- [Retrieve a session](https://docs.gumloop.com/api-reference/sessions/retrieve-session)
- [Resolve approvals](https://docs.gumloop.com/api-reference/sessions/resolve-approvals)
- [Cancel a session](https://docs.gumloop.com/api-reference/sessions/cancel-session)
- [Existing official JavaScript SDK](https://github.com/gumloop/gumloop-js)
