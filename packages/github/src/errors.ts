/** Error taxonomy shared by the GitHub App adapter and the user-integration service. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code: string = "github_error",
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export class GitHubNotConfiguredError extends GitHubError {
  constructor(readonly missing: string[] = []) {
    super(
      missing.length > 0
        ? `GitHub App is not configured. Missing: ${missing.join(", ")}. No GitHub action was taken.`
        : "GitHub App is not configured. No GitHub action was taken.",
      503,
      "not_configured",
    );
    this.name = "GitHubNotConfiguredError";
  }
}

/** The user's authorization expired or was revoked. The developer must reconnect. */
export class GitHubAuthError extends GitHubError {
  constructor(message = "GitHub authorization expired or was revoked. Reconnect your GitHub account.") {
    super(message, 401, "authentication_expired");
    this.name = "GitHubAuthError";
  }
}

export class GitHubPermissionError extends GitHubError {
  constructor(message = "GitHub denied access to this resource. Check the App installation permissions and repository selection.") {
    super(message, 403, "permission_denied");
    this.name = "GitHubPermissionError";
  }
}

export class GitHubNotFoundError extends GitHubError {
  constructor(message = "The requested GitHub resource was not found or is not accessible with this installation.") {
    super(message, 404, "not_found");
    this.name = "GitHubNotFoundError";
  }
}

export class GitHubValidationError extends GitHubError {
  constructor(message: string) {
    super(message, 400, "invalid_request");
    this.name = "GitHubValidationError";
  }
}

export class GitHubInstallationSuspendedError extends GitHubError {
  constructor(message = "This GitHub App installation is suspended. Restore it in GitHub before continuing.") {
    super(message, 409, "installation_suspended");
    this.name = "GitHubInstallationSuspendedError";
  }
}

export class GitHubRateLimitError extends GitHubError {
  constructor(
    message: string,
    readonly resetAt: string | null,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message, 429, "rate_limited");
    this.name = "GitHubRateLimitError";
  }
}

/** Remove credential material from anything that may surface in a log or HTTP response. */
export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
