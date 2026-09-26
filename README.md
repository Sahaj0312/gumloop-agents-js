# Relay — Widget Studio for Gumloop

A visual studio for turning Gumloop agents into embeddable website chat. Pick an agent, design the widget, test a real conversation in the preview, and publish a script tag. Includes an unofficial TypeScript SDK and standalone developer examples.

This is an **unofficial**, self-hosted prototype, not affiliated with or endorsed by Gumloop. It is not published to npm.

## Run the studio

The studio runs on Cloudflare Workers with D1 persistence. Each deployment has one password-protected owner workspace with multiple widgets. Gumloop credentials stay on the backend. Studio development requires Node.js 22 or newer.

```sh
npm install
cp .dev.vars.example .dev.vars
# Fill in a strong studio password, encryption key, and optional Gumloop credentials.
npm run studio:migrate
npm run studio:dev
```

Open **http://localhost:3200**. Sign in, connect Gumloop if needed, and create a widget from an accessible agent. Appearance edits have an interactive desktop/mobile preview. Drafts stay separate from the published design; the agent editor explicitly saves changes to the real Gumloop agent.

See [studio setup and deployment](docs/studio.md). The original standalone widget and SDK examples are below.

Gumloop's public JavaScript package currently exposes legacy workflow operations. Its current Agents API supports conversations, streaming, cancellations, and approvals. This project makes those operations available from TypeScript while preserving the underlying API events.

## Try the website widget

Requires Node.js 20.12 or newer and a Gumloop account with API access.

```sh
npm install
cp .env.example .env
# Fill in your API key, user ID, and the ID of an agent intended for visitors.
npm run widget
```

In another terminal:

```sh
npm run website
```

Open **http://127.0.0.1:3100**. The fictional Northstar Studio website loads the chat bubble from a separate server on port 3001 using one script tag. The agent and sample policies must be configured in your own Gumloop account; the example does not create or train an agent automatically.

For your own website, host the widget backend and install:

```html
<script
  src="https://your-widget-server.example/widget.js"
  data-widget-id="demo"
  defer
></script>
```

Allow your website's exact origin in the backend configuration. Your Gumloop key stays on the backend; the snippet contains no credentials. Set the title, greeting, and accent color through environment variables. See [widget setup](docs/widget.md) for configuration, visitor isolation, usage limits, and deployment boundaries.

## Run the developer playground

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

The SDK covers Agents and sessions rather than the full Gumloop API. Relay provides one owner workspace for designing and publishing multiple widgets, with anonymous visitor conversation ownership. It does not provide multi-customer signup or billing, verify a visitor's real-world identity, or authorize access to customer accounts. Use a dedicated agent containing information and abilities appropriate for anonymous visitors.

## API references

- [Current Python SDK](https://docs.gumloop.com/api-reference/sdk/python)
- [Create and stream sessions](https://docs.gumloop.com/api-reference/sessions/create-session)
- [Retrieve a session](https://docs.gumloop.com/api-reference/sessions/retrieve-session)
- [Resolve approvals](https://docs.gumloop.com/api-reference/sessions/resolve-approvals)
- [Cancel a session](https://docs.gumloop.com/api-reference/sessions/cancel-session)
- [Existing official JavaScript SDK](https://github.com/gumloop/gumloop-js)
