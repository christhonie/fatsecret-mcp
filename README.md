# FatSecret MCP — Remote / Streamable HTTP

A remote MCP server that exposes your FatSecret nutrition diary to
[claude.ai](https://claude.ai) as a custom connector over HTTPS.

Forked from [fliptheweb/fatsecret-mcp](https://github.com/fliptheweb/fatsecret-mcp).
This fork swaps the stdio transport for **Streamable HTTP**
(MCP spec 2025-03-26+), gates the endpoint with a shared bearer token, and
adds a Dockerfile + Kubernetes manifests for deployment behind a TLS
ingress with cert-manager.

The upstream tool set (~40 tools: food search, recipes, food diary, monthly
nutrition summary, weight, exercises, favorites, saved meals) is preserved
verbatim — only the transport layer and credential loading were changed.

---

## Architecture

```
            HTTPS                bearer token             pre-authed
claude.ai ──────────► Ingress ──────────────► /mcp ──────► FatSecret API
                      (cert-manager,            │           (OAuth 1.0a)
                       Let's Encrypt)           │
                                    Deployment (1 replica)
                                    └─ envFrom: fatsecret-mcp-secrets
```

- **Single-user.** The pre-authenticated OAuth 1.0a user token is provisioned
  once locally via `npm run bootstrap` and baked into a Kubernetes Secret.
  There is no per-user auth flow on the deployed instance — `start_auth`,
  `complete_auth` and `setup_credentials` are deliberately disabled when
  running over HTTP.
- **Bearer-token auth.** All `/mcp` traffic must present
  `Authorization: Bearer <MCP_BEARER_TOKEN>`. claude.ai supports custom
  headers per connector.
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

Also generate the bearer token that claude.ai will present:

```bash
openssl rand -hex 32
```

---

## 3. Build & push the container image

```bash
docker build -t ghcr.io/YOUR_GH_USER/fatsecret-mcp:0.1.0 .
docker push  ghcr.io/YOUR_GH_USER/fatsecret-mcp:0.1.0
```

The image is `node:20-alpine`-based, runs as uid `1001`, listens on `:8000`,
and exposes a `/healthz` endpoint for the readiness/liveness probes.

---

## 4. Deploy to Kubernetes

Update the image reference in [k8s/deployment.yaml](k8s/deployment.yaml#L31)
and the hostname in [k8s/ingress.yaml](k8s/ingress.yaml#L29-L36)
(`fatsecret-mcp.YOURDOMAIN.com`), then:

```bash
# Namespace
kubectl apply -f k8s/namespace.yaml

# Secret — recommended: create imperatively to avoid checking values in.
kubectl -n fatsecret-mcp create secret generic fatsecret-mcp-secrets \
  --from-literal=FATSECRET_CLIENT_ID=...           \
  --from-literal=FATSECRET_CLIENT_SECRET=...       \
  --from-literal=FATSECRET_CONSUMER_SECRET=...     \
  --from-literal=FATSECRET_ACCESS_TOKEN=...        \
  --from-literal=FATSECRET_ACCESS_TOKEN_SECRET=... \
  --from-literal=MCP_BEARER_TOKEN=...

# Workload
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
```

Wait for cert-manager to issue the certificate:

```bash
kubectl -n fatsecret-mcp get certificate fatsecret-mcp-tls -w
```

Smoke test:

```bash
curl -sS https://fatsecret-mcp.YOURDOMAIN.com/healthz
# → {"status":"ok"}

curl -sS https://fatsecret-mcp.YOURDOMAIN.com/mcp -X POST \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# → JSON-RPC initialize response with Mcp-Session-Id in the response headers
```

---

## 5. Register the server in claude.ai

1. Open <https://claude.ai/settings/connectors>.
2. **Add custom connector**.
3. Fields:
   - **Name**: `FatSecret`
   - **Remote MCP server URL**: `https://fatsecret-mcp.YOURDOMAIN.com/mcp`
   - **Custom header**: `Authorization: Bearer <MCP_BEARER_TOKEN>`
4. Save. claude.ai will call `initialize` and `tools/list`; you should see
   the FatSecret tool set show up. Test by asking "What did I eat today?"
   — Claude will call `get_food_entries` for the current date.

---

## Local development

Run the HTTP server locally without K8s:

```bash
# Populate .env with the same five FATSECRET_* + MCP_BEARER_TOKEN values
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
  Secret, and `kubectl rollout restart deployment/fatsecret-mcp -n fatsecret-mcp`.
- **Rotating the bearer token.** Change `MCP_BEARER_TOKEN` in the Secret,
  restart, then update the header in the claude.ai connector config.
- **Egress IP.** If FatSecret IP restrictions are enabled, make sure your
  cluster's SNAT/egress IP is allow-listed — otherwise every call returns
  an opaque OAuth error.

---

## Credits & licence

- Upstream FatSecret MCP implementation: [fliptheweb/fatsecret-mcp](https://github.com/fliptheweb/fatsecret-mcp) (MIT).
- Original prior art (stdio-only, hand-rolled OAuth 1.0a): [fcoury/fatsecret-mcp](https://github.com/fcoury/fatsecret-mcp) (MIT).
- This fork: MIT. See [LICENSE](LICENSE).
