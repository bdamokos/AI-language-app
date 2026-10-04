# Language AI App

Language practice with grammar explanations, reading passages, and interactive exercises. Each learner signs in with ChatGPT and authorizes requests against their own eligible ChatGPT plan.

## Hosted sign-in prerequisite

OpenAI must approve the website for **Sign in with ChatGPT and ChatGPT plan usage**. [Apply for access](https://openai.com/form/sign-in-with-chatgpt-interest/) and register the exact callback URL, normally `https://YOUR_DOMAIN/api/auth/callback`.

An identity-only client cannot run inference. The open-source dynamic registration flow uses a local loopback callback and is not a substitute for approval of a shared hosted website. This app uses the registered hosted flow, with no shared provider key or automatic billing fallback. Until a client is configured, the site shows a setup message and refuses generation requests.

See the official [website sign-in guide](https://developers.openai.com/siwc/website), [ChatGPT plan usage guide](https://developers.openai.com/siwc/token-sharing-open-source), and [Responses limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). Hosted plan scopes and eligibility must be provisioned for the registered client by OpenAI.

## Development

Requires Node.js 22.12 or newer.

```sh
cp env.example .env
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. Vite forwards `/api` to the backend on port 3000. Use the configured hostname exactly, because sessions and OAuth callbacks are bound to `APP_ORIGIN`.

For live OAuth, configure an approved `OPENAI_CLIENT_ID` and register `http://127.0.0.1:5173/api/auth/callback` for development. Set `OPENAI_TOKEN_AUTH_METHOD` to the method OpenAI provisions (`none` or `client_secret_basic`); confidential clients also need the server-only `OPENAI_CLIENT_SECRET`.

```sh
npm test
```

The tests use local signed OAuth and Responses fixtures. They exercise PKCE, ID-token validation, account isolation, streaming failures, cache concurrency, and the application API without using a real account or charging inference. Passing them does not establish OpenAI approval or live account eligibility.

For an interactive demonstration, run `npm run preview:fixture` and open `http://127.0.0.1:3001`. Its separate local authorization page offers two test accounts and simulated lessons. This entrypoint is excluded from the production image.

## Production

```sh
npm ci
npm run build
APP_ORIGIN=https://YOUR_DOMAIN HOST=127.0.0.1 npm start
```

Serve the app through an HTTPS reverse proxy. Preserve the public `Host` header and forward `/api` to the same backend. The server validates the raw `Host` and `Origin` headers against the configured origin; forwarded host/protocol headers do not override these checks. The registered redirect URI must match `APP_ORIGIN` and `/api/auth/callback` exactly. Do not log callback query strings or authorization headers at the proxy.

For per-client rate limits behind a proxy, set `TRUSTED_PROXY_CIDRS` to a comma-separated list of the **proxy peer addresses actually seen by Node**. The default is empty, so direct clients cannot choose their IP through `X-Forwarded-For`. For a same-host proxy connecting directly to Node over loopback, use `TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128`. With Docker port forwarding, identify the bridge gateway or proxy container IP seen by the application and allow that specific address instead; do not copy the loopback example without checking the network path. For multiple controlled proxies, include their exact addresses or dedicated proxy-only subnets. Names, hop counts, wildcards, `/0`, and IPv4-mapped IPv6 CIDRs are rejected. The public-facing proxy must overwrite untrusted client `X-Forwarded-For` values with the real client address, and the backend port must be reachable only through the intended route. Express walks the address chain back to the first untrusted peer.

Sign-in endpoints allow 120 requests per minute per client, with 10 login attempts within that budget. Production assets and SPA routes share a separate 600-request-per-minute client limit. Authenticated lesson APIs retain their independent per-account limit.

Set private, persistent `AUTH_DIR` and `CACHE_DIR` locations outside the static site. Use **one Node process per storage pair**. The file store serializes refreshes and cache writes in that process; multiple replicas require a shared transactional session store before deployment.

`AUTH_DIR` holds the encryption key and encrypted session data with owner-only permissions. Back up the whole directory securely; protect the key and ciphertext together as credentials. Session cookies are HttpOnly, SameSite=Lax, and Secure on HTTPS. Tokens never enter browser storage. Signing out clears the local session and attempts to revoke its renewable OpenAI grant; an unconfirmed remote revocation is reported to the user.

For Docker, create writable subdirectories for the unprivileged container user, then start Compose:

```sh
sudo install -d -m 700 -o 1000 -g 1000 /var/lib/language-ai-app/auth /var/lib/language-ai-app/cache
docker compose up --build -d
```

Compose binds the app to loopback for a reverse proxy on the host. Adapt the network binding deliberately if your proxy runs elsewhere. Configure `APP_ORIGIN` and the approved OAuth client in `.env` before starting it. No OpenRouter, Runware, fal.ai, or Ollama credentials are used.

The optional `deploy.sh` remote helper requires `REGISTRY_HOST`, including in `--deploy-only` mode. It pulls the selected image before replacing the running service and requires an already verified SSH host key in `known_hosts`. Verify and add the server fingerprint through a trusted channel before first use; unknown or changed keys stop deployment. Direct local Compose builds remain supported.

## Account and inference boundaries

- OpenAI supplies identity and explicitly granted plan permissions. The app owns its separate browser sessions and CSRF protection.
- Models come from the signed-in account's catalog. Every request uses that account's access token and the public `https://api.openai.com/v1/responses` endpoint.
- Responses use `store: false`, `stream: true`, and explicit input. A lesson is saved only after `response.completed`; failed, interrupted, refused, or incomplete generations surface an error.
- Explanations, exercise pools, base texts, and ratings live in separate account cache directories. The previous anonymous shared cache is left on disk but is never served or imported.
- Private prompts, answers, tokens, and model output are not published through debugging or logging routes. Arbitrary URL downloads and operator-funded image generation have been removed. Existing text exercises and PDF export remain available.
- Users can review usage and disconnect the app in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

After registration, verify the real hosted flow with two different accounts: sign in, generate and answer an exercise, reload a cached lesson, switch models, then sign out. Confirm each account sees only its own content and that usage is attributed to the correct ChatGPT account.
