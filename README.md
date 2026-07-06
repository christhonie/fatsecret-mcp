# FatSecret MCP — Remote / Streamable HTTP

A remote MCP server that exposes your FatSecret nutrition diary to
[claude.ai](https://claude.ai) as a custom connector over HTTPS.

Forked from [fliptheweb/fatsecret-mcp](https://github.com/fliptheweb/fatsecret-mcp).
This fork swaps the stdio transport for **Streamable HTTP**
(MCP spec 2025-03-26+), implements OAuth 2.1 with PKCE so claude.ai's
custom-connector UI can register and authenticate against it, and adds
a Dockerfile + Kubernetes manifests for deployment behind a TLS ingress
with cert-manager.

The upstream tool set (~40 tools: food search, recipes, food diary, monthly
nutrition summary, weight, exercises, favorites, saved meals) is preserved
verbatim — only the transport layer and credential loading were changed.

---

## Architecture

```
                   OAuth 2.1 + PKCE        OAuth 1.0a (pre-authed)
claude.ai ─────► /authorize, /token ─────► /mcp ─────────► FatSecret API
                 (this server is the              │         (single user's
                  authorization server)           │          baked-in token)
                                       Deployment (1 replica)
                                       └─ envFrom: fatsecret-mcp-secrets
```

- **Single-user.** The pre-authenticated OAuth 1.0a user token is provisioned
  once locally via `npm run bootstrap` and baked into a Kubernetes Secret.
  There is no per-user FatSecret auth flow on the deployed instance —
  `start_auth`, `complete_auth` and `setup_credentials` are deliberately
  disabled when running over HTTP.
- **OAuth 2.1 + PKCE for the connector.** claude.ai's custom-connector UI
  requires the MCP server to *be* an OAuth 2.0 authorization server. The
  deployment ships a minimal one (see `src/oauth-provider.ts`) that
  exposes `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource`, `/authorize`, `/token`, and
  `/revoke`. There is a single pre-registered client whose
  `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` you paste into claude.ai.
  Authorization is "always approve" — the operator is the only user.
- **Stateful sessions.** The server allocates an `Mcp-Session-Id` on
  initialize and keeps one in-memory MCP server per session, which also
  lets the OAuth 2.0 cache (used for public food search) live across calls.

---

## Prerequisites

- Node.js 20+
- Docker (for the container build)
- `kubectl` access to a cluster with an ingress controller and cert-manager
  (Let's Encrypt). The manifests assume nginx-ingress and a ClusterIssuer
  named `letsencrypt-prod` — adjust if yours differ.
- A registered FatSecret Platform developer application.

---

## 1. FatSecret platform setup

1. Create a free account at <https://platform.fatsecret.com/>.
2. **My Account → API Keys**. You'll see three values you need to capture:
   - **Client ID** — used by both OAuth 2.0 (public food search) and OAuth 1.0a (signing as the consumer key).
   - **Client Secret** — OAuth 2.0 secret, for public food / recipe endpoints.
   - **Consumer Secret** — OAuth 1.0a secret, for user-scoped endpoints (food diary, weight, profile). This is **different** from the Client Secret.
3. Under **My Account → Manage IP Restrictions**, either disable the IP
   allow-list or add the egress IP(s) of your Kubernetes cluster. FatSecret
   rejects API calls from unlisted IPs when restrictions are enabled.

---

## 2. Bootstrap the OAuth 1.0a user token (one-time, local)

```bash
npm install
npm run build
npm run bootstrap
```

The CLI prompts for the three credentials (or reads them from env if
already exported), opens the FatSecret authorization page in your browser,
asks for the verifier PIN, and prints a block of env vars to copy:

```
FATSECRET_CLIENT_ID=...
FATSECRET_CLIENT_SECRET=...
FATSECRET_CONSUMER_SECRET=...
FATSECRET_ACCESS_TOKEN=...
FATSECRET_ACCESS_TOKEN_SECRET=...
```

Also generate an OAuth client ID + secret that claude.ai will use to
authenticate against this server:

```bash
echo "OAUTH_CLIENT_ID=fsmcp-$(openssl rand -hex 8)"
echo "OAUTH_CLIENT_SECRET=$(openssl rand -hex 32)"
```

Keep these values — you'll paste them into claude.ai's connector UI later.

---

## 3. Build & push the container image

The cluster pulls a public Docker Hub image. No imagePullSecret required.

```bash
docker build -t docker.io/christhonie/fatsecret-mcp:0.1.0 .
docker push  docker.io/christhonie/fatsecret-mcp:0.1.0
```

The image is `node:20-alpine`-based, runs as uid `1001`, listens on `:8000`,
and exposes a `/healthz` endpoint for the readiness/liveness probes.

---

## 4. Deploy to Kubernetes

Deployment is driven by ArgoCD. The Application manifest lives in
[idl-xnl-jhb-rc01/argocd/fatsecret-mcp.yml](https://github.com/christhonie/idl-xnl-jhb-rc01/blob/main/argocd/fatsecret-mcp.yml)
and syncs the [k8s/](k8s/) directory of this repo (with `secret.template.yaml`
excluded). Pushing a commit to `main` here triggers an ArgoCD sync.

The one manual prerequisite is the Secret — values must never enter git:

```bash
export KUBECONFIG=/mnt/c/Users/chris/.kube/static/idl-xnl-jhb1-01.yaml

# Ensure the namespace exists (ArgoCD creates it too; harmless if it does).
kubectl create namespace mcp --dry-run=client -o yaml | kubectl apply -f -

kubectl -n mcp create secret generic fatsecret-mcp-secrets \
  --from-literal=FATSECRET_CLIENT_ID=...           \
  --from-literal=FATSECRET_CLIENT_SECRET=...       \
  --from-literal=FATSECRET_CONSUMER_SECRET=...     \
  --from-literal=FATSECRET_ACCESS_TOKEN=...        \
  --from-literal=FATSECRET_ACCESS_TOKEN_SECRET=... \
  --from-literal=OAUTH_CLIENT_ID=...               \
  --from-literal=OAUTH_CLIENT_SECRET=...
```

By default the server pre-registers these redirect URIs for the OAuth
client (see [src/http-server.ts](src/http-server.ts)):

- `https://claude.ai/api/mcp/auth_callback`
- `https://claude.com/api/mcp/auth_callback`
- `http://localhost:3000/callback`

If claude.ai's actual callback URL differs, override via the
`OAUTH_REDIRECT_URIS` env var (comma-separated, exact-match per OAuth 2.1).

Watch the rollout and cert issuance:

```bash
kubectl -n mcp rollout status deployment/fatsecret-mcp
kubectl -n mcp get certificate fatsecret-mcp-christhonie-co-za-tls -w
```

Smoke test:

```bash
# Public probe
curl -sS https://fatsecret-mcp.christhonie.co.za/healthz
# → {"status":"ok"}

# Authorization server metadata (RFC 8414)
curl -sS https://fatsecret-mcp.christhonie.co.za/.well-known/oauth-authorization-server

# Protected resource metadata (RFC 9728)
curl -sS https://fatsecret-mcp.christhonie.co.za/.well-known/oauth-protected-resource

# Unauthenticated MCP request: 401 with WWW-Authenticate header pointing
# at the metadata URL — this is what claude.ai consumes to discover the
# auth endpoints.
curl -sS -D - -o /dev/null -X POST https://fatsecret-mcp.christhonie.co.za/mcp \
  -H 'Content-Type: application/json' -d '{}'
```

The full OAuth code-grant + PKCE flow is best driven by claude.ai itself
(see next section). To drive it from curl, generate a PKCE pair
(`code_verifier` random, `code_challenge = base64url(sha256(code_verifier))`),
hit `/authorize` to receive a redirect with `?code=...`, POST that code to
`/token` with the verifier, and use the returned `access_token` in
`Authorization: Bearer <token>` on `/mcp`.

---

## 5. Register the server in claude.ai

1. Open <https://claude.ai/settings/connectors>.
2. **Add custom connector**.
3. Fields:
   - **Name**: `FatSecret`
   - **Remote MCP server URL**: `https://fatsecret-mcp.christhonie.co.za/mcp`
   - **Advanced settings → OAuth Client ID**: the `OAUTH_CLIENT_ID` you generated
   - **Advanced settings → OAuth Client Secret**: the `OAUTH_CLIENT_SECRET` you generated
4. Save. claude.ai discovers the auth endpoints via
   `/.well-known/oauth-authorization-server`, then walks you through an
   OAuth 2.1 + PKCE authorization-code flow. Since the server runs in
   single-user "always approve" mode, the authorize step is automatic —
   no consent screen.
5. After authorization, claude.ai calls `initialize` and `tools/list`;
   you should see the FatSecret tool set. Test by asking "What did I eat
   today?" — Claude will call `get_food_entries` for the current date.

---

## Local development

Run the HTTP server locally without K8s:

```bash
# Populate .env with the five FATSECRET_* values plus OAUTH_CLIENT_ID,
# OAUTH_CLIENT_SECRET, and optionally OAUTH_ISSUER_URL / OAUTH_REDIRECT_URIS.
cp .env.example .env

# Node 20.6+ supports --env-file natively
npm run build
node --env-file=.env dist/http-server.js
```

Run the stdio variant against Claude Desktop / Claude Code (useful for
diffing behaviour vs. the remote deployment):

```bash
npm run build
node --env-file=.env dist/index.js
```

---

## Available tools

The full ~40-tool set inherited from upstream is documented at
[fliptheweb/fatsecret-mcp](https://github.com/fliptheweb/fatsecret-mcp#-available-tools).
Highlights relevant to a coaching workflow:

- `search_foods`, `get_food`, `find_food_by_barcode`, `autocomplete_foods`
- `get_food_entries`, **`get_food_entries_month`** (daily calorie & macro
  summary for a calendar month — the monthly nutrition view), `create_food_entry`,
  `edit_food_entry`, `delete_food_entry`, `copy_food_entries`
- `get_weight_month`, `update_weight`
- `get_exercise_entries_month`, `get_exercises`
- `get_profile`

The auth tools (`setup_credentials`, `start_auth`, `complete_auth`) are
**not exposed** over HTTP — they only make sense for the local stdio
bootstrap. `check_auth_status` is also auth-tool-suite-only and so is
disabled in HTTP mode.

---

## Operational notes

- **Read-only root FS.** The container runs with `readOnlyRootFilesystem: true`.
  This is fine for HTTP mode (no config file writes), but if you ever run
  the stdio binary inside the container (e.g. for ad-hoc bootstrap), you'll
  need an `emptyDir` volume mounted at `/home/app/.fatsecret-mcp/`.
- **Token rotation.** When you regenerate the OAuth token (e.g. after
  revoking on FatSecret's side), re-run `npm run bootstrap`, update the
  Secret, and `kubectl -n mcp rollout restart deployment/fatsecret-mcp`.
- **Rotating the OAuth client credentials.** Change `OAUTH_CLIENT_ID`
  and/or `OAUTH_CLIENT_SECRET` in the Secret, restart the deployment,
  then re-enter the new values in the claude.ai connector config (which
  forces a fresh OAuth authorization-code exchange).
- **Rotating the redirect URIs.** If claude.ai changes its callback URL,
  override the comma-separated `OAUTH_REDIRECT_URIS` env var on the
  Deployment (add it under `env:` in [k8s/deployment.yaml](k8s/deployment.yaml))
  and restart.
- **Egress IP.** If FatSecret IP restrictions are enabled, make sure your
  cluster's SNAT/egress IP is allow-listed — otherwise every call returns
  an opaque OAuth error.

---

## Generalising this pattern

If you're building the *next* remote MCP wrapper (hevy-mcp, Wahoo Kickr,
Strava, anything else), don't re-derive the architecture from this
project alone — read the playbook at
[~/dev/ai-skills-develop/skills/devops/remote-mcp-wrap/SKILL.md](../ai-skills-develop/skills/devops/remote-mcp-wrap/SKILL.md).
It captures what's reusable (Streamable HTTP + OAuth 2.1 provider +
K8s/ArgoCD/cert-manager pattern + per-node egress probe + the bootstrap
CLI traps) and what varies per upstream (auth model, IP whitelisting).

Concrete reusable assets in this repo:

- [src/oauth-provider.ts](src/oauth-provider.ts) — copy-as-is. Single-user "always approve"
  OAuth 2.1 authorization server. No FatSecret-specific code.
- [src/http-server.ts](src/http-server.ts) — copy and adapt the upstream class import
  + env-var names. The wiring (Express, mcpAuthRouter, requireBearerAuth,
  per-session transport) is generic.
- [Dockerfile](Dockerfile), [k8s/](k8s/), the ArgoCD app in
  [../idl-xnl-jhb-rc01/argocd/fatsecret-mcp.yml](../idl-xnl-jhb-rc01/argocd/fatsecret-mcp.yml)
  — copy and rename.

Things that bit this project that you should NOT repeat:

- Starting with a `MCP_BEARER_TOKEN` design. claude.ai's connector UI
  doesn't accept custom headers — the OAuth 2.1 provider is mandatory.
  Half a day lost; entire `http-server.ts` rewritten. See commit
  `23a18f5 v0.2.0: replace bearer-token gate with OAuth 2.1 + PKCE`.
- Hand-rolling masked-password input that mixes with `readline.question`
  in the bootstrap CLI. The masked input takes over stdin in a state
  that breaks the next readline question silently. See `src/bootstrap.ts`
  comments.
- Forgetting that `kubectl apply` doesn't drop removed Secret keys.
  Use `delete + create` when changing schema (e.g. `MCP_BEARER_TOKEN`
  → `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET`).
- Whitelisting only the egress IP of the node the pod happens to sit
  on. The cluster is per-node SNAT — k01/k02/k03 each have their own
  public egress IP and pods get scheduled to any of them. Whitelist all.

---

## Credits & licence

- Upstream FatSecret MCP implementation: [fliptheweb/fatsecret-mcp](https://github.com/fliptheweb/fatsecret-mcp) (MIT).
- Original prior art (stdio-only, hand-rolled OAuth 1.0a): [fcoury/fatsecret-mcp](https://github.com/fcoury/fatsecret-mcp) (MIT).
- This fork: MIT. See [LICENSE](LICENSE).
