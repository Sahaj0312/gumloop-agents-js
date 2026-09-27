# Relay Widget Studio

Relay is a visual editor for website chat widgets backed by Gumloop agents. It runs as one Cloudflare Worker with static assets and a D1 database. Gumloop runs the agents; Relay stores widget designs and routes visitor conversations.

Each visitor can create a separate private workspace connected to their own Gumloop account. A generated access code reopens that workspace. This release does not include email signup, billing, shared team membership, or account recovery.

## Using the studio

1. Create a private workspace with your Gumloop personal API key and user ID, then save the generated workspace access code. To return, choose the existing-workspace option and enter that code. The original deployment owner can still use the original studio password.
2. Pick an accessible agent and create a widget.
3. Customize its title, welcome message, color, theme, avatar, suggested questions, size, and placement.
4. Test the actual widget in the interactive preview. Desktop and mobile controls change the preview viewport. Real preview conversations consume Gumloop credits.
5. Save the draft, add the exact website origins where the widget should run, and publish.
6. Copy the generated script tag into your website. Published design updates appear on subsequent widget loads without replacing the snippet.

In Appearance, **Launcher style** controls the button that opens the chat: icon and text, icon only, or text only. Enter an emoji or symbol for an icon. Blank icon and text fields stay blank; no fallback content is inserted. If the selected style has no visible icon or text, the launcher is hidden. Icon-only buttons keep an accessible name based on the chat title.

Widget drafts and the published configuration are separate. Saving a draft does not change an installed widget. Publishing copies the saved draft and its origin list into the public configuration. Unpublishing disables public access.

Agent editing is separate: **Save agent updates the real agent in Gumloop**. Its name, description, instructions, and model can affect every place that agent runs. Cosmetic preview changes do not write to Gumloop. Full connector, skill, and knowledge-source administration remains in Gumloop.

## Local development

Requires Node 22 or newer for the studio development tools. The standalone SDK retains its existing Node requirement.

```sh
npm install
cp .dev.vars.example .dev.vars
# Fill in your local secrets.
npm run studio:migrate
npm run studio:dev
```

Open http://localhost:3200. Local Wrangler uses a local D1 database. Remote production records are separate. Apply all migrations before starting or deploying an updated build; the workspace migration preserves existing owner widgets.

Generate a random password and encryption key with a password manager or a local cryptographic generator. Do not commit `.dev.vars`. Keep the encryption key stable: changing it prevents decrypting previously saved credentials.

## Deploying your own instance

1. Authenticate Wrangler with your Cloudflare account.
2. Create a dedicated D1 database. Update `account_id`, `database_name`, and `database_id` in `wrangler.jsonc` for your account; the checked-in identifiers belong to the original deployment.
3. Apply the schema with `wrangler d1 migrations apply <database-name> --remote`.
4. Prepare a private JSON secrets file with `STUDIO_PASSWORD`, `ENCRYPTION_KEY`, and optionally `GUMLOOP_API_KEY` and `GUMLOOP_USER_ID`.
5. Run the build, type check, and deployment:

```sh
npm run studio:assets
npm run studio:typecheck
npx wrangler deploy --dry-run
npx wrangler deploy --secrets-file /private/path/studio-secrets.json
```

The deployment serves the studio, preview, widget JavaScript, authenticated API, and public conversation API from the same HTTPS origin. There is no separate Vercel deployment to configure.

`studio:types` uses the checked-in `.dev.vars.example` to generate binding types without needing real credentials. Development and deployment still use their own private secrets.

`studio:assets` copies the existing widget runtime into the deployment assets. The installed widget and studio preview use the same JavaScript implementation.

## Access and credentials

Each workspace access code grants control of that workspace and its connected account's accessible agents. Save it privately: it is shown once and cannot be recovered. Browser login uses an HttpOnly session cookie. Public embeds never receive the Gumloop key or the studio cookie. Signing out lets someone create or open another workspace without changing existing embeds.

Credentials supplied through the connection form are encrypted with AES-256-GCM before being stored in D1 and bound to the workspace through authenticated encryption. An API key preconfigured as a Worker secret is available only to the original owner workspace. Widget visitors receive separate anonymous tokens, and conversation operations verify ownership. A preview token is short-lived and restricted to the studio origin; it allows testing unpublished designs without publishing them.

Connection settings let users replace their key or disconnect. Disconnect removes the stored credential, stops public widget access, and keeps draft designs. It does not revoke the key at Gumloop or cancel work already started there. Use another workspace for a different Gumloop account.

See [architecture and credential handling](architecture.md) for the request flow, isolation boundaries, and a short demo-video explanation.

Allowed origins are an embedding restriction, not proof of a visitor's identity. Use agents whose instructions, knowledge, memory, and tools are appropriate for anonymous visitors. Chat API ownership checks do not prevent an agent's tools from accessing private information available to the account. Customer account lookups and sensitive actions need application-level authorization.

Public usage consumes the connected Gumloop account's credits. Request limits constrain traffic, not exact spending. This release does not include payment collection, bot challenges, or usage billing.
