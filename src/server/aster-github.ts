/**
 * Minimal GitHub REST client for Aster's repository picker. The token (a fine-grained
 * PAT in `GITHUB_TOKEN`) stays in the server's environment; cells reach GitHub only
 * through Hotcell's credential gateway with their own revocable egress token.
 */

export interface AsterRepository {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  updatedAt: string | null;
}

export class AsterGitHubError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "AsterGitHubError";
  }
}

export const REPOSITORY_FULL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REPOSITORY_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const API = "https://api.github.com";

interface RawRepository {
  full_name: string;
  name: string;
  owner?: { login?: string };
  private: boolean;
  description: string | null;
  default_branch?: string;
  pushed_at?: string | null;
  updated_at?: string | null;
}

export class AsterGitHub {
  constructor(
    private readonly token: string | undefined = process.env.GITHUB_TOKEN,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.token?.trim());
  }

  /** Repositories the token can push to, most recently pushed first. */
  async listRepositories(query = ""): Promise<AsterRepository[]> {
    const raw = await this.request<RawRepository[]>(
      "GET",
      "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
    );
    const needle = query.trim().toLowerCase();
    return raw
      .map(mapRepository)
      .filter((repo) => !needle || repo.fullName.toLowerCase().includes(needle) || (repo.description ?? "").toLowerCase().includes(needle));
  }

  async getRepository(fullName: string): Promise<AsterRepository> {
    if (!REPOSITORY_FULL_NAME_RE.test(fullName)) throw new AsterGitHubError("Invalid repository name", 400, "invalid_repository");
    return mapRepository(await this.request<RawRepository>("GET", `/repos/${fullName}`));
  }

  /** Creates a repository under the token's user, initialized so it has a default branch to clone. */
  async createRepository(input: { name: string; private: boolean; description?: string }): Promise<AsterRepository> {
    if (!REPOSITORY_NAME_RE.test(input.name) || input.name === "." || input.name === "..") {
      throw new AsterGitHubError("Repository names may use letters, digits, '.', '_' and '-'", 400, "invalid_repository_name");
    }
    const description = input.description?.trim().slice(0, 350);
    return mapRepository(await this.request<RawRepository>("POST", "/user/repos", {
      name: input.name,
      private: input.private,
      auto_init: true,
      ...(description ? { description } : {}),
    }));
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (!this.configured) throw new AsterGitHubError("GitHub is not connected on the server", 503, "github_not_configured");
    let response: Response;
    try {
      response = await this.fetchImpl(API + path, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "autopilot-aster",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AsterGitHubError("GitHub could not be reached", 502, "github_unreachable");
    }
    if (response.ok) return await response.json() as T;
    const detail = await response.json().catch(() => ({})) as { message?: string; errors?: Array<{ message?: string }> };
    const message = detail.errors?.[0]?.message ?? detail.message ?? `GitHub returned HTTP ${response.status}`;
    if (response.status === 404) throw new AsterGitHubError("Repository not found or not accessible with the server's GitHub token", 404, "repository_not_found");
    if (response.status === 401) throw new AsterGitHubError("The server's GitHub token was rejected", 502, "github_token_rejected");
    if (response.status === 403) throw new AsterGitHubError(`GitHub refused the request: ${message}`, 403, "github_forbidden");
    if (response.status === 422) throw new AsterGitHubError(message, 422, "github_validation_failed");
    throw new AsterGitHubError(message, 502, "github_error");
  }
}

function mapRepository(raw: RawRepository): AsterRepository {
  return {
    fullName: raw.full_name,
    name: raw.name,
    owner: raw.owner?.login ?? raw.full_name.split("/")[0] ?? "",
    private: raw.private,
    description: raw.description,
    defaultBranch: raw.default_branch ?? "main",
    updatedAt: raw.pushed_at ?? raw.updated_at ?? null,
  };
}
