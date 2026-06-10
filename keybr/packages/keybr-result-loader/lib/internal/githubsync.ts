import { type Result } from "@keybr/result";
import { formatFile, parseFile } from "@keybr/result-io";
import { PersistentResultStorage } from "./local.ts";
import { type ProgressListener, type ResultStorage } from "./types.ts";

const OWNER = "saeed-alzeera";
const REPO = "verdict-cat";
const RESULTS_PATH = "keybr/data/results.bin";
const API = "https://api.github.com";

function getToken(): string | null {
  const t = (globalThis as any).__GITHUB_TOKEN__;
  return typeof t === "string" && t.length > 0 ? t : null;
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
  bytes: Uint8Array,
  sha: string | null,
  message: string,
): Promise<void> {
  const token = getToken();
  if (!token) return;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  const body: Record<string, unknown> = { message, content: btoa(binary) };
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

async function githubDelete(path: string, sha: string): Promise<void> {
  const token = getToken();
  if (!token) return;
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: "clear keybr results", sha }),
  });
  if (!res.ok && res.status !== 404)
    throw new Error(`GitHub ${res.status}`);
}

export class GitHubBackedResultStorage implements ResultStorage {
  readonly #local = new PersistentResultStorage();

  async load(pl: ProgressListener = noop): Promise<Result[]> {
    if (!getToken()) {
      return this.#local.load();
    }
    try {
      const file = await githubGet(RESULTS_PATH);
      if (file) {
        const base64 = file.content.replace(/\n/g, "");
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++)
          bytes[i] = binary.charCodeAt(i);
        const remoteResults = [...parseFile(bytes)];
        if (remoteResults.length > 0) {
          await this.#local.clear();
          await this.#local.append(remoteResults);
          return remoteResults;
        }
      }
    } catch (err) {
      console.warn("[github-sync] load failed, falling back to local", err);
    }
    const localResults = await this.#local.load();
    if (localResults.length > 0) {
      this.#pushAllToGitHub(localResults);
    }
    return localResults;
  }

  async append(results: readonly Result[], pl: ProgressListener = noop): Promise<void> {
    await this.#local.append(results);
    if (getToken()) {
      this.#local.load().then((all) => this.#pushAllToGitHub(all));
    }
  }

  async clear(): Promise<void> {
    await this.#local.clear();
    if (getToken()) {
      githubGet(RESULTS_PATH)
        .then((f) => f && githubDelete(RESULTS_PATH, f.sha))
        .catch((err) => console.warn("[github-sync] clear failed", err));
    }
  }

  #pushAllToGitHub(results: Result[]): void {
    (async () => {
      const bytes = formatFile(results);
      const file = await githubGet(RESULTS_PATH);
      await githubPut(RESULTS_PATH, bytes, file?.sha ?? null, "update keybr results");
    })().catch((err) => console.warn("[github-sync] push failed", err));
  }
}

function noop(_total: number, _current: number): void {}
