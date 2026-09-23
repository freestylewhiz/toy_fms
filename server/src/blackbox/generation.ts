import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlackboxGeneration } from "../../../shared/blackbox.ts";

export const BLACKBOX_GENERATION_FILE = ".generation.json";
export const LEGACY_GENERATION: BlackboxGeneration = { id: "legacy", createdAt: 0 };
export const BLACKBOX_MUTATION_LOCK = ".mutation-lock";

export async function readGeneration(root: string): Promise<BlackboxGeneration> {
  try {
    const value = JSON.parse(await readFile(join(root, BLACKBOX_GENERATION_FILE), "utf8")) as Partial<BlackboxGeneration>;
    if (typeof value.id === "string" && value.id && Number.isFinite(value.createdAt)) return { id: value.id, createdAt: Number(value.createdAt) };
  } catch { /* legacy roots predate generation manifests */ }
  return LEGACY_GENERATION;
}

export async function ensureGeneration(root: string): Promise<BlackboxGeneration> {
  const current = await readGeneration(root);
  if (current.id !== LEGACY_GENERATION.id) return current;
  // Do not create a manifest for a legacy root just by reading it. A newly
  // created recorder gets a generation only when it first writes, preserving
  // compatibility with fixtures and existing data.
  return current;
}

export async function writeGeneration(root: string, generation: BlackboxGeneration): Promise<void> {
  await mkdir(root, { recursive: true });
  const temporary = join(root, `${BLACKBOX_GENERATION_FILE}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(generation) + "\n", "utf8");
  await rename(temporary, join(root, BLACKBOX_GENERATION_FILE));
}

export function newGeneration(): BlackboxGeneration {
  return { id: randomUUID(), createdAt: Date.now() };
}

type MutationOwner = { pid: number; token: string; createdAt: number };

async function lockOwner(root: string): Promise<MutationOwner | undefined> {
  try { return JSON.parse(await readFile(join(root, BLACKBOX_MUTATION_LOCK, "owner.json"), "utf8")) as MutationOwner; } catch { return undefined; }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function withMutationLock<T>(root: string, operation: () => Promise<T>, waitMs = 30_000): Promise<T> {
  await mkdir(root, { recursive: true });
  const started = Date.now();
  const token = randomUUID();
  while (true) {
    const lock = join(root, BLACKBOX_MUTATION_LOCK);
    let acquired = false;
    try {
      await mkdir(lock);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (acquired) {
      const owner: MutationOwner = { pid: process.pid, token, createdAt: Date.now() };
      try {
        await writeFile(join(lock, "owner.json"), JSON.stringify(owner) + "\n", "utf8");
        return await operation();
      } finally {
        const current = await lockOwner(root);
        if (current?.token === token) await rm(lock, { recursive: true, force: true });
      }
    }
    const owner = await lockOwner(root);
    let stale = !!owner && !processAlive(owner.pid);
    if (!owner) {
      try { stale = Date.now() - (await stat(lock)).mtimeMs > 30_000; } catch { stale = false; }
    }
    if (stale) {
      await rm(lock, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    if (Date.now() - started >= waitMs) throw new Error("blackbox mutation lock is held by a live process");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
