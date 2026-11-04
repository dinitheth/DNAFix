# GitHub App setup

DNAFix uses a **GitHub App**, never a personal access token. The App provides three separate credentials:

| Credential | Used for | Lifetime |
|---|---|---|
| App JWT (RS256) | Creating installation access tokens | 9 minutes (generated per request) |
| User access token | `GET /user`, `GET /user/installations`, installation repository discovery | 8 hours; refresh token rotates it |
| Installation access token | Repository metadata, issues, cloning, draft PRs | 1 hour; cached until 5 minutes before expiry |

DNAFix never sends any of these tokens to the browser. User and refresh tokens are encrypted at rest with AES-256-GCM; installation tokens are cached in API process memory only.

---

## 1. Register the App

Open **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.

Use these values. Replace `http://localhost:3001` with your public API origin in production.

| Field | Development value | Production value |
|---|---|---|
| GitHub App name | `DNAFix (dev)` | Your production name |
| Homepage URL | `http://localhost:5173` | `https://your-dnafix.example` |
| User authorization callback URL | `http://localhost:3001/api/v1/integrations/github/callback` | `https://api.your-dnafix.example/api/v1/integrations/github/callback` |
| Setup URL | `http://localhost:3001/api/v1/integrations/github/setup` | `https://api.your-dnafix.example/api/v1/integrations/github/setup` |
| Redirect on update | **Enabled** | Enabled |
| Webhook URL | Optional: `http://localhost:3001/api/v1/webhooks/github` | Optional: `https://api.your-dnafix.example/api/v1/webhooks/github` |
| Webhook secret | Optional (`GITHUB_WEBHOOK_SECRET`) | Optional |
| Where can this App be installed? | Any account | Any account or your organization only |
| Request user authorization (OAuth) during installation | **Disabled** | Disabled |
| Expire user authorization tokens | **Enabled** | Enabled |
| Device flow | Disabled | Disabled |

> The callback and setup URLs must exactly match the environment values. A mismatch produces GitHub's `redirect_uri_mismatch` error.

### Repository permissions (least privilege)

| Permission | Access | Why |
|---|---|---|
| Metadata | Read | Required by GitHub for every App installation |
| Contents | Read | Repository access and cloning private repositories |
| Issues | Read | Listing, searching and reading issue details |
| Pull requests | Read (optional) | Detect and exclude pull requests from issue results |

Do **not** grant organization permissions for this feature. Do **not** grant contents or pull-request write access unless you are deliberately enabling the existing draft-PR delivery path; that path is separate and remains human-approved. DNAFix never merges.

### Generate credentials

1. On the App page, copy **App ID**.
2. Under **Client secrets**, generate a client secret and copy it once.
3. Under **Private keys**, generate a private key (`.pem`) and download it.
4. Copy the **Client ID** (not the App ID) from the App page.
5. Note the App slug from its public URL: `https://github.com/apps/<slug>`.

Encode the private key for the API:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\dnafix.private-key.pem"))
```

```bash
base64 -w0 dnafix.private-key.pem
```

Generate the token-encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Store both values in your secret manager. Never commit `.env` or the `.pem` file.

---

## 2. Configure DNAFix

Copy `.env.example` to `.env` and fill in:

```env
GITHUB_APP_ID=123456
GITHUB_APP_CLIENT_ID=Iv1.abcdef123456
GITHUB_APP_CLIENT_SECRET=...
GITHUB_APP_PRIVATE_KEY_BASE64=...
GITHUB_APP_SLUG=dnafix-dev
APP_BASE_URL=http://localhost:3001
GITHUB_API_VERSION=2022-11-28
GITHUB_TOKEN_ENCRYPTION_KEY=...
```

Optional explicit overrides if your callbacks differ from `APP_BASE_URL`:

```env
GITHUB_APP_USER_CALLBACK_URL=https://api.example.com/api/v1/integrations/github/callback
GITHUB_APP_SETUP_URL=https://api.example.com/api/v1/integrations/github/setup
```

Restart the API process after changing these values. `GITHUB_APP_PRIVATE_KEY` (literal PEM with `\n` escapes) is still accepted for older deployments, but `GITHUB_APP_PRIVATE_KEY_BASE64` is recommended.

### Required values and failure behavior

When a value is missing, DNAFix reports the exact missing names:

- `GET /api/v1/config/status` → `github.missing`
- `GET /api/v1/integrations/github/status` → `missing`
- The New Analysis page shows “GitHub App is not configured” with the list.

No connection is simulated. The Connect button stays disabled and no GitHub API call is attempted.

`GITHUB_INSTALLATION_ID` is only a legacy fallback for draft-PR delivery on runs without a verified per-user installation. User-connected repositories carry their own verified installation ID.

### Production persistence

Local development uses the shared SQLite store under `DNAFIX_DATA_DIR` (`dnafix.sqlite`; `DNAFIX_STORE=file` selects the older JSON store). Encrypted connections are stored in `githubConnections`. For PostgreSQL:

```bash
pnpm db:migrate
```

Migration `0002_github_app_integration.sql` creates `github_user_connections` and adds installation/issue provenance columns. Tokens are stored only as ciphertext.

### Cookies and origins

The API sets an opaque `dnafix_sid` cookie with `HttpOnly`, `SameSite=Lax`, and `Secure` when `NODE_ENV=production` or `APP_BASE_URL` starts with `https://`. It contains no token or account data.

The web app and API must be same-origin in production, or the web app must proxy `/api` to the API. The Vite development server already proxies `/api` to `http://localhost:3001`.

---

## 3. Connect and install

1. Open **New Analysis**, choose **GitHub repository**, click **Connect GitHub**.
2. Authorize the App on GitHub. GitHub redirects to the callback URL.
3. DNAFix exchanges the code server-side, calls `GET /user`, then `GET /user/installations`.
4. If the account has exactly one installation, DNAFix selects it. Otherwise choose one in the UI.
5. If there is no installation, click **Install GitHub App**, choose the account/organization and repositories, and complete the setup redirect.
6. The setup callback's `installation_id` is **not trusted directly**. DNAFix checks it against the authenticated user's accessible installations before persisting anything. Organization installs that require owner approval are reported as pending.

The selected installation and repository context are validated again when a run is created.

---

## 4. Token lifecycle

- User tokens expire after 8 hours when **Expire user authorization tokens** is enabled.
- Refresh tokens are single-use and rotate. DNAFix serializes concurrent refreshes per session with a single-flight guard so the same refresh token is never used twice.
- Installation tokens expire after 1 hour and are cached per installation + repository scope, refreshed 5 minutes before expiry.
- Installation tokens are requested with repository scope and only `metadata: read`, `contents: read`, `issues: read`.
- Disconnect revokes the user grant and the installation token where possible, then deletes the encrypted connection. Revocation failures are reported but never keep credentials on the server.

---

## 5. Security properties

| Requirement | Implementation |
|---|---|
| No PATs | Only App JWT, user OAuth token, installation token |
| No browser secrets | API responses contain only normalized account/repo/issue DTOs |
| Tokens at rest | AES-256-GCM, versioned payload, AAD bound to session + token kind |
| OAuth CSRF | 256-bit single-use state, server-side, 10-minute expiry, bound to HttpOnly session cookie |
| Spoofed installation IDs | Verified through `GET /user/installations`; setup callback replay rejected by state consumption |
| Repository authorization | Checked against the user's installation repository list before every issue list/detail/run |
| Run provenance | Backend re-fetches the issue and re-validates installation/repository before accepting a run |
| Logging | Tokens are never logged; git errors redact token and Basic-auth material |
| Disconnect | Grant revocation + installation token revocation + local deletion |

---

## 6. Verification checklist

After configuration:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @dnafix/web build
```

Manual live checks (require real GitHub credentials):

1. `GET /api/v1/config/status` shows `github.missing: []` and `github.userIntegrationConfigured: true`.
2. Connect redirects to GitHub and returns with `?github=connected`.
3. The account avatar and login match GitHub.
4. Repositories reflect the installation's selected repositories.
5. Issue lists exclude pull requests and search uses GitHub's search API.
6. Selecting an issue populates the title, Markdown body and tracking reference.
7. Starting an analysis creates a run with `issueUrl` and `githubInstallationId` provenance.
8. Disconnect removes the account and encrypted record.

The offline test suite mocks every GitHub response and requires no credentials.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `redirect_uri_mismatch` | Callback URL in the App does not match `GITHUB_APP_USER_CALLBACK_URL` / `APP_BASE_URL` |
| `bad_verification_code` | Authorization code reused or expired; restart Connect |
| “state is invalid, expired, or already used” | Callback replay, expired 10-minute state, or a different browser session |
| “not accessible to the authenticated user” | Setup callback installation was spoofed or belongs to another account |
| 403 on issues | Issues permission not granted, or repository not selected for the installation |
| “installation suspended” | Restore the installation in GitHub → Settings → Applications |
| 401 after eight hours | Refresh token expired or grant revoked; reconnect |
| No repositories | App installed on an account/organization with no repository selection |
| Organization install pending | An organization owner must approve the App request |
