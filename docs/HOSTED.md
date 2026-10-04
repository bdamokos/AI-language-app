# Hosted deployment

The hosted server is an optional layer. The default `npm start`, `npm run dev`, and `npm run preview` commands continue to run the local application. Use the explicit hosted commands below for a shared website.

Live hosted sign-in and inference have not yet been verified. The local acceptance results and simulated-provider tests do not establish website approval or hosted account eligibility.

## Registration

OpenAI must approve the website for **Sign in with ChatGPT and ChatGPT plan usage**. [Apply for access](https://openai.com/form/sign-in-with-chatgpt-interest/) and register the exact callback URL, normally `https://YOUR_DOMAIN/api/auth/callback`.

An identity-only client cannot run inference. Local open-source dynamic registration is not a substitute for approval of a shared hosted website. The hosted server uses its registered client, with no shared provider key or automatic billing fallback. Until a client is configured, the site shows a setup message and refuses generation requests.

See OpenAI's [website sign-in guide](https://developers.openai.com/siwc/website), [ChatGPT plan usage guide](https://developers.openai.com/siwc/token-sharing-open-source), and [Responses limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). Hosted plan scopes and eligibility must be provisioned for the registered client by OpenAI.

## Development

Requires Node.js 22.12 or newer. From the repository root:

```sh
cp env.example .env
npm ci
npm run dev:hosted
```

Open **http://127.0.0.1:5173**. The explicit `vite.hosted.config.js` forwards `/api` to the backend on port 3000. Use the configured hostname exactly: sessions and OAuth callbacks are bound to `APP_ORIGIN`.

For live OAuth, configure an approved `OPENAI_CLIENT_ID` and register `http://127.0.0.1:5173/api/auth/callback` for development. Set `OPENAI_TOKEN_AUTH_METHOD` to the method OpenAI provisions, either `none` or `client_secret_basic`. Confidential clients also need the server-only `OPENAI_CLIENT_SECRET`.

The hosted server reads `.env` from its working directory. Keep it private and run the commands from the repository root. Local entrypoints ignore these hosted settings.

```sh
npm test
npm run preview:hosted-fixture
```

The test suite uses signed local OAuth and Responses fixtures, without real accounts or inference charges. The separate hosted fixture at **http://127.0.0.1:3001** offers two simulated accounts and lesson examples. It uses temporary data, and its entrypoint and provider are excluded from the production image. Stop it with Ctrl+C. The default `preview:fixture` continues to use the local-client fixture on port 3002.

## Production

Configure `.env` with the public HTTPS origin and the approved hosted client, then run:

```sh
npm ci
npm run build
APP_ORIGIN=https://YOUR_DOMAIN HOST=127.0.0.1 npm run start:hosted
```

`start:hosted` runs `server/hosted.js` in production mode. The default `server/index.js` remains a local entrypoint.

Serve the app through an HTTPS reverse proxy. Preserve the public `Host` header and route `/api` to the same backend. The server validates the raw `Host` and `Origin` against `APP_ORIGIN`; forwarded host/protocol headers do not override these checks. The registered redirect URI must match the configured origin and `/api/auth/callback` exactly. Do not log callback query strings or authorization headers at the proxy.

For per-client rate limits, set `TRUSTED_PROXY_CIDRS` to the comma-separated proxy peer addresses **actually seen by Node**. Leave it empty for direct access. A same-host proxy connecting directly over loopback can use `127.0.0.1/32,::1/128`. With Docker port forwarding, verify the bridge gateway or proxy container address and allow that specific peer instead. For multiple controlled proxies, include their exact addresses or dedicated proxy-only subnets.

Names, hop counts, wildcards, `/0`, and IPv4-mapped IPv6 CIDRs are rejected. The public-facing proxy must overwrite untrusted client `X-Forwarded-For` values, and the backend must be reachable only through the intended route. Express walks the forwarded address chain back to the first untrusted peer.

Sign-in endpoints allow 120 requests per minute per client, including a limit of 10 login attempts. Production assets and SPA routes share a separate 600-request-per-minute client limit. Authenticated lesson APIs retain their independent per-account limit.

## Storage and sessions

Set private, persistent `AUTH_DIR` and `CACHE_DIR` locations outside the static site. Use **one Node process per storage pair**. Multiple replicas require a shared transactional session store.

`AUTH_DIR` holds the encryption key and encrypted session data with owner-only permissions. Back up the whole directory securely and protect the key and ciphertext together as credentials. Cookies are HttpOnly, SameSite=Lax, and Secure on HTTPS. Tokens never enter browser storage. Signing out clears the browser session and attempts remote grant revocation; an unconfirmed remote revocation is reported to the user.

Each account's explanations, exercises, base texts, ratings, and model preferences remain separate. The hosted entrypoint uses the same maintained authentication, inference, and application modules as the local app. It does not import or reuse credentials from the local application-data directory.

## Docker and remote deployment

The production image explicitly runs `server/hosted.js` as the unprivileged `node` user. Compose binds the application port to loopback, drops Linux capabilities, and enables `no-new-privileges`.

Create private writable storage for the container user, then start Compose:

```sh
sudo install -d -m 700 -o 1000 -g 1000 /var/lib/language-ai-app/auth /var/lib/language-ai-app/cache
docker compose up --build -d
```

Configure `APP_ORIGIN` and the approved OAuth client in `.env` first. Adapt the network binding deliberately if the reverse proxy runs elsewhere. No OpenRouter, Runware, fal.ai, or Ollama credentials are used.

The optional `deploy.sh` remote helper requires `REGISTRY_HOST`, including in `--deploy-only` mode. It pulls the selected registry image before replacing the service. SSH requires an already verified host key in `known_hosts`; verify the server fingerprint through a trusted channel before first use. Unknown or changed keys stop deployment. Direct local Compose builds remain supported.

## Live acceptance before release

After website registration and deployment, verify the real hosted flow with two different accounts: sign in, generate and answer an exercise, reload cached content, change models, export a PDF, and sign out. Confirm account isolation, correct usage attribution, and the reported revocation outcome. These deployment-specific checks remain pending.
