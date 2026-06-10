import { Settings, type SettingsStorage } from "@keybr/settings";

const OWNER = "saeed-alzeera";
const REPO = "verdict-cat";
const SETTINGS_PATH = "keybr/data/settings.json";
const API = "https://api.github.com";

const GITHUB_TOKEN_KEY = "keybr_github_token";

function getToken(): string | null {
  return localStorage.getItem(GITHUB_TOKEN_KEY);
}

type FileInfo = { content: string; sha: string };

async function githubGet(path: string): Promise<FileInfo | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json() as Promise<FileInfo>;
}

async function githubPut(
  path: string,
  text: string,
  sha: string | null,
  message: string,
): Promise<void> {
  const token = getToken();
  if (!token) return;
  const body: Record<string, unknown> = { message, content: btoa(text) };
  if (sha) body.sha = sha;
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
}

export class GitHubBackedSettingsStorage implements SettingsStorage {
  readonly #localKey: string;

  constructor(localKey: string) {
    this.#localKey = localKey;
  }

  async load(): Promise<Settings> {
    if (getToken()) {
      try {
        const file = await githubGet(SETTINGS_PATH);
        if (file) {
          const json = JSON.parse(atob(file.content.replace(/\n/g, "")));
          localStorage.setItem(this.#localKey, JSON.stringify(json));
          return new Settings(json as any);
        }
      } catch (err) {
        console.warn("[github-sync] settings load failed, using local", err);
      }
    }
    const raw = localStorage.getItem(this.#localKey);
    if (raw != null) {
      try {
        return new Settings(JSON.parse(raw) as any);
      } catch {
        // fall through
      }
    }
    const defaults = new Settings(undefined, true);
    localStorage.setItem(this.#localKey, JSON.stringify(defaults.toJSON()));
    return defaults;
  }

  async store(settings: Settings): Promise<Settings> {
    const json = settings.toJSON();
    localStorage.setItem(this.#localKey, JSON.stringify(json));
    if (getToken()) {
      (async () => {
        const file = await githubGet(SETTINGS_PATH);
        await githubPut(
          SETTINGS_PATH,
          JSON.stringify(json, null, 2),
          file?.sha ?? null,
          "update keybr settings",
        );
      })().catch((err) =>
        console.warn("[github-sync] settings store failed", err),
      );
    }
    return settings;
  }
}
