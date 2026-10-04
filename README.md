# Language AI App

Language practice with grammar explanations, reading passages, and interactive exercises. Each learner signs in with ChatGPT and authorizes requests against their own eligible ChatGPT plan.

## Run on your own computer

Requires Node.js 22.12 or newer. From this checkout:

```sh
npm ci
npm run local
```

Open **http://127.0.0.1:3210**, choose **Continue with ChatGPT**, and allow Language AI App to use your ChatGPT plan. Choose a language, level, and topic to start a lesson. Your account's eligibility and usage limits apply. This uses OpenAI's [self-service registration for local open-source clients](https://developers.openai.com/siwc/token-sharing-open-source/sign-in); no website approval, API key, or OpenRouter subscription is needed. OpenAI's preview may still be unavailable to a particular account, workspace, or region.

Keep the terminal open while using the app; press Ctrl+C to stop. After the first build, `npm start` starts it again; `npm run start:local` is an alias. Re-run `npm run local` after updating the source. The local entrypoint ignores hosted `.env`, `HOST`, `APP_ORIGIN`, OAuth client settings, and proxy settings. It always binds to `127.0.0.1`; do not expose it through a tunnel, reverse proxy, or shared host.

Saved accounts, model preferences, and generated-content caches survive restarts in your operating system's private application-data directory:

| System | Data directory |
| --- | --- |
| macOS | `~/Library/Application Support/Language AI App` |
| Windows | `%LOCALAPPDATA%\Language AI App` |
| Linux | `$XDG_DATA_HOME/language-ai-app`, or `~/.local/share/language-ai-app` |

Credentials stay in encrypted files under `auth/`, with an owner-only encryption key alongside them; lessons stay under `cache/` in separate account directories. Protect this whole directory as credentials, including backups. Filesystem permissions on Windows also depend on your user's profile-directory ACLs. Tokens are never saved in browser storage. The app does not use another program's ChatGPT credentials.

Local mode is intended for your own trusted computer and OS session. Loopback HTTP cookies are shared across ports, so other local services and users on that computer are part of the trust boundary.

Select a model in account settings; an explicit choice is saved for that local registration. Models shown are those available to the signed-in account. ChatGPT-plan access currently excludes image generation.

Choose a saved account to sign in again, or **Add another ChatGPT account**. Each registration stays separate, including registrations sharing an email address. Signing out stops requests, attempts remote revocation, and removes that account's local tokens while retaining its registration for a later sign-in. You can also disconnect the app in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

Optional settings are `LANGUAGE_AI_PORT` (default `3210`) and `LANGUAGE_AI_DATA_DIR` (default above). Keep the same data directory to reuse your host identifier and registrations. A different loopback port is allowed on later launches; always open the exact `127.0.0.1` address printed in the terminal.

Only one process can use a data directory at a time. A second launch refuses to start. After an abrupt crash, inspect `runtime.lock/owner.json` inside the data directory and verify that its process has stopped before removing the `runtime.lock` directory. The app never steals this lock after a timeout, including when a computer sleeps.

## Development and verification

`npm run dev` and `npm run preview` both build and start the same local app at **http://127.0.0.1:3210**. These commands do not provide hot module replacement: stop the app and run the command again after changing source. No `.env` file or approved website client is required. The historical `node server/index.js` entrypoint also starts the local app after a build.

```sh
npm test
```

The tests build the app and use signed local OAuth and Responses fixtures. They exercise PKCE, ID-token validation, account isolation, streaming failures, cache concurrency, and the application API without using a real account or charging inference. Shared hosted-protocol tests remain to protect the authentication foundation; passing them does not establish OpenAI approval or live account eligibility.

For an interactive demonstration, run `npm run preview:fixture` and open **http://127.0.0.1:3002**. Its simulated provider offers two test accounts and generated lesson examples, including local registration and the saved-account picker. `npm run preview:local-fixture` is an alias for this local demonstration.

To inspect the shared hosted protocol against the simulated provider, use `npm run preview:fixture -- --hosted` at **http://127.0.0.1:3001**. This is a test fixture, not a shared website deployment. Both previews use temporary data separate from your real accounts, and neither proves live ChatGPT eligibility.

## Hosted website work

Shared website deployment remains in [pending PR #11](https://github.com/bdamokos/AI-language-app/pull/11), awaiting OpenAI approval for website sign-in and ChatGPT plan usage. This local release includes no Docker, reverse-proxy, or remote-deployment setup. Local self-service registration cannot be used to bypass the hosted approval requirement.

## Account and inference boundaries

- OpenAI supplies identity and explicitly granted plan permissions. The app owns its separate browser sessions and CSRF protection.
- Models come from the signed-in account's catalog. Every request uses that account's access token and the public `https://api.openai.com/v1/responses` endpoint.
- Responses use `store: false`, `stream: true`, and explicit input. A lesson is saved only after `response.completed`; failed, interrupted, refused, or incomplete generations surface an error.
- Explanations, exercise pools, base texts, and ratings live in separate account cache directories. The previous anonymous shared cache is left on disk but is never served or imported.
- Private prompts, answers, tokens, and model output are not published through debugging or logging routes. Arbitrary URL downloads and operator-funded image generation have been removed. Existing text exercises and PDF export remain available.
- Users can review usage and disconnect the app in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

See [local acceptance results](docs/LOCAL_ACCEPTANCE.md) for the recorded verification of sign-in, exercise generation, account isolation, and PDF export.
