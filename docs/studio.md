# Relay Widget Studio

Relay is a visual editor for website chat widgets backed by Gumloop agents. It runs as one Cloudflare Worker with static assets and a D1 database. Gumloop runs the agents; Relay stores widget designs and routes visitor conversations.

This release has one password-protected owner workspace per deployment. It supports multiple widgets connected to agents in that Gumloop account. It is not a multi-customer SaaS with signup, billing, teams, or password recovery.

## Using the studio

1. Sign in with the studio password. If no account is preconnected, enter your Gumloop personal API key and user ID on the connection screen.
2. Pick an accessible agent and create a widget.
3. Customize its title, welcome message, color, theme, avatar, suggested questions, size, and placement.
4. Test the actual widget in the interactive preview. Desktop and mobile controls change the preview viewport. Real preview conversations consume Gumloop credits.
5. Save the draft, add the exact website origins where the widget should run, and publish.
6. Copy the generated script tag into your website. Published design updates appear on subsequent widget loads without replacing the snippet.

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

Open http://localhost:3200. Local Wrangler uses a local D1 database. Remote production records are separate.

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

`studio:assets` copies the existing widget runtime into the deployment assets. The installed widget and studio preview use the same JavaScript implementation.

## Access and credentials

The studio password grants control of the connected account's accessible agents and all saved widget configurations. Keep it private. Browser login uses an HttpOnly session cookie. Public embeds never receive the Gumloop key or the studio cookie.

Credentials supplied through the connection form are encrypted before being stored in D1. An API key preconfigured as a Worker secret stays in Cloudflare's secret binding. Widget visitors receive separate anonymous tokens, and conversation operations verify ownership. A preview token is short-lived and restricted to the studio origin; it allows testing unpublished designs without publishing them.

Allowed origins are an embedding restriction, not proof of a visitor's identity. Use agents whose instructions, knowledge, memory, and tools are appropriate for anonymous visitors. Chat API ownership checks do not prevent an agent's tools from accessing private information available to the account. Customer account lookups and sensitive actions need application-level authorization.

Public usage consumes the connected Gumloop account's credits. Request limits constrain traffic, not exact spending. This release does not include payment collection, bot challenges, or usage billing.
