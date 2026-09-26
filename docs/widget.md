# Embeddable website chat

The widget puts a Gumloop conversation inside an existing website. The browser loads a small JavaScript file, which creates a floating button and an isolated chat panel. A Node server communicates with Gumloop using the TypeScript SDK.

## Local setup

1. Create a dedicated Gumloop agent for your website. Give it the instructions and knowledge visitors need.
2. Copy `.env.example` to `.env` and set `GUMLOOP_API_KEY`, `GUMLOOP_USER_ID`, and `GUMLOOP_WIDGET_AGENT_ID`.
3. Set `GUMLOOP_WIDGET_ALLOWED_ORIGINS` to `http://127.0.0.1:3100` for the sample website.
4. Start `npm run widget`, then `npm run website` in a second terminal.
5. Open http://127.0.0.1:3100 and use the chat button.

The sample website is fictional. It contains no real booking or payment flow. The included HTML alone does not give an agent any knowledge; configure its answers in Gumloop.

## Add it to your own site

Serve the widget backend over HTTPS, and add the website's exact origin, including its scheme and any non-default port, to `GUMLOOP_WIDGET_ALLOWED_ORIGINS`:

```dotenv
GUMLOOP_WIDGET_AGENT_ID=your_public_agent_id
GUMLOOP_WIDGET_ALLOWED_ORIGINS=https://www.example.com,https://example.com
GUMLOOP_WIDGET_TITLE=Ask our team
GUMLOOP_WIDGET_WELCOME=Hi! How can I help?
GUMLOOP_WIDGET_ACCENT="#bc6547"
GUMLOOP_WIDGET_PUBLIC_URL=https://your-widget-server.example
# Set this when your container or reverse proxy needs a non-loopback listener:
GUMLOOP_WIDGET_HOST=0.0.0.0
```

Then include the script near the end of the page or with `defer`:

```html
<script src="https://your-widget-server.example/widget.js"
        data-widget-id="demo" defer></script>
```

The script's URL identifies the backend. The public widget ID identifies a server-side configuration. Neither value is a secret or an authentication credential. The agent ID is chosen on the server, not by visitors.

The page uses Shadow DOM to prevent normal host-page CSS from changing the chat layout. It displays visitor and agent text without treating it as HTML. Browser storage keeps the visitor token and conversation reference so reloading can restore the conversation; no third-party cookie is required.

## Conversations and recovery

Each visitor receives a random bearer token. The backend stores a hash and binds it to that widget and website origin. Every conversation lookup, message, cancellation, and approval verifies ownership before calling Gumloop. Knowing another conversation's identifier is not enough to access it.

The server creates an idle Gumloop conversation before sending the first message. The browser keeps that reference and never retries a message automatically after an uncertain network failure. It recovers by reading the existing conversation. Closing the chat panel does not submit the message again or implicitly cancel work.

Messages stream as text. The saved Gumloop session supplies the final state and transcript. A task may complete, fail, or pause for input. The Stop control sends an explicit cancellation request; it is separate from closing an HTTP connection.

Human-input questions with supported choices can be answered in the widget. Public visitors cannot approve privileged tool actions. An agent waiting for another kind of approval requires its owner's attention. Custom Other answer encodings and every possible input question schema are not supported.

## Deployment boundaries

This is a single-process, self-hosted MVP. Keep its store on a persistent volume. Do not run multiple independent instances against one store file. Production multi-instance operation needs a shared database, shared rate limiter, and coordinated concurrency control.

Deploy behind HTTPS and make sure your proxy forwards streaming responses without buffering. Configure the allowed website origins explicitly. Origin checks restrict browser embedding; they do not authenticate a person or prevent a non-browser client from forging an Origin header.

Use an agent specifically intended for anonymous website visitors. The agent runs with the credentials configured in Gumloop. This prototype does not make an internal agent with private customer data or powerful connectors safe for public use. Identity-based order lookup, account changes, bookings, and payments need separate application authentication and authorization.

Request limits constrain traffic, not exact monetary spend: different Gumloop requests can consume different credits. The prototype is not a billing system, CAPTCHA service, or distributed abuse-prevention platform.

The default limits allow 15 messages per visitor per minute, 60 messages globally per minute, and four concurrent runs. Each visitor can create ten conversations per minute and retain twenty. Tokens expire after seven days. The persistent file at `.local/widget-store.json` contains token hashes and conversation mappings, not transcripts or plaintext tokens. Rate counters and active-run accounting are in memory and reset on restart. Limits can be overridden through `createWidgetServer({ limits: ... })`; there is no settings dashboard.

The server uses the connecting socket's IP for visitor issuance limits and does not trust forwarded IP headers. Behind a proxy, visitors share that issuance limit unless you implement trusted-proxy handling. `GUMLOOP_WIDGET_PUBLIC_URL` adds the deployment hostname to the Host allowlist. `WIDGET_PORT` changes the backend port; the sample website uses `WEBSITE_PORT` and `WIDGET_ORIGIN` when overriding its default port 3100 and backend URL.

The existing developer playground at port 3000 remains local and separate. Do not publish that privileged account-wide playground as the public widget backend.
