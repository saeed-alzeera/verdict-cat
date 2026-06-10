import { body, controller, http, pathParam } from "@fastr/controller";
import { Context } from "@fastr/core";
import { BadRequestError } from "@fastr/errors";
import { injectable } from "@fastr/invert";
import { type RouterState } from "@fastr/middleware-router";
import { DataDir } from "@keybr/config";
import { File } from "@sosimple/fsx-file";
import { LockFile } from "@sosimple/fsx-lockfile";
import { exponentialDelay } from "@sosimple/retry";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type AuthState } from "../auth/index.ts";

type Snippet = {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
};

@injectable()
@controller()
export class TextTransportController {
  constructor(readonly dataDir: DataDir) {}

  @http.GET("/_/text-transport")
  async getSnippets(ctx: Context<RouterState & AuthState>) {
    const { id } = ctx.state.requireUser();
    const snippets = await this.#load(id!);
    ctx.response.body = snippets;
    ctx.response.headers.set("Cache-Control", "private, no-cache");
  }

  @http.POST("/_/text-transport")
  async addSnippet(
    ctx: Context<RouterState & AuthState>,
    @body.json(null, { maxLength: 65536 }) value: unknown,
  ) {
    if (
      typeof value !== "object" ||
      value == null ||
      typeof (value as any).text !== "string"
    ) {
      throw new BadRequestError();
    }
    const text = ((value as any).text as string).trim();
    if (!text) {
      throw new BadRequestError();
    }
    const { id } = ctx.state.requireUser();
    const snippets = await this.#load(id!);
    const snippet: Snippet = {
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
    };
    await this.#save(id!, [snippet, ...snippets]);
    ctx.response.status = 201;
    ctx.response.body = snippet;
  }

  @http.DELETE("/_/text-transport/{snippetId:[a-zA-Z0-9-]+}")
  async deleteSnippet(
    ctx: Context<RouterState & AuthState>,
    @pathParam("snippetId") snippetId: string,
  ) {
    const { id } = ctx.state.requireUser();
    const snippets = await this.#load(id!);
    const filtered = snippets.filter((s) => s.id !== snippetId);
    await this.#save(id!, filtered);
    ctx.response.status = 204;
  }

  async #load(userId: number): Promise<Snippet[]> {
    const file = new File(this.#filePath(userId));
    try {
      const json = await file.readJson();
      return Array.isArray(json) ? (json as Snippet[]) : [];
    } catch (err: any) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }

  async #save(userId: number, snippets: Snippet[]): Promise<void> {
    const filePath = this.#filePath(userId);
    await mkdir(dirname(filePath), { recursive: true });
    const file = new File(filePath);
    await LockFile.withLock(
      file,
      { retryLimit: 5, delayer: exponentialDelay(10) },
      async (lock) => {
        await lock.writeFile(JSON.stringify(snippets, null, 2));
        await lock.commit();
      },
    );
  }

  #filePath(userId: number): string {
    const s = String(userId).padStart(9, "0");
    return this.dataDir.dataPath(
      "text_transport",
      s.substring(0, 3),
      s.substring(3, 6),
      s + ".json",
    );
  }
}
