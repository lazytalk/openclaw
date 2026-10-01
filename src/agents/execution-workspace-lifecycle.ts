import { randomUUID } from "node:crypto";
import path from "node:path";
import { root, type Root } from "../infra/fs-safe.js";

const processIdentity = randomUUID();
const activeRoots = new Set<string>();
const LEASE_FILE = ".openclaw-owner.json";
const OWNER_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

export function reserveHostWorkspace(absolutePath: string): () => void {
  activeRoots.add(absolutePath);
  return () => {
    activeRoots.delete(absolutePath);
  };
}

export async function removeWorkspaceTree(storage: Root, directory = ""): Promise<void> {
  const entries = await storage.list(directory, { withFileTypes: true });
  // Keep the lease until content is reclaimed so an interrupted cleanup remains reapable.
  entries.sort((a, b) => Number(a.name === LEASE_FILE) - Number(b.name === LEASE_FILE));
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory && !entry.isSymbolicLink) {
      await removeWorkspaceTree(storage, relative);
    }
    await storage.remove(relative);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

/** Reclaim only generated dead-process roots. A live owner keeps its lease across long runs. */
export async function reapHostExecutionWorkspaces(stateDir: string): Promise<void> {
  const state = await root(stateDir, { symlinks: "reject", hardlinks: "reject" });
  await state.mkdir("runtime-workspaces");
  const base = await root(path.join(state.rootReal, "runtime-workspaces"), {
    symlinks: "reject",
    hardlinks: "reject",
  });
  let checked = 0;
  for (const owner of await base.list("", { withFileTypes: true })) {
    if (++checked > 1024) {
      throw new Error(
        "Execution workspace maintenance capacity reached; administrator cleanup required",
      );
    }
    if (!OWNER_PATTERN.test(owner.name) || !owner.isDirectory || owner.isSymbolicLink) {
      continue;
    }
    for (const run of await base.list(owner.name, { withFileTypes: true })) {
      if (++checked > 1024) {
        throw new Error(
          "Execution workspace maintenance capacity reached; administrator cleanup required",
        );
      }
      if (!RUN_PATTERN.test(run.name) || !run.isDirectory || run.isSymbolicLink) {
        continue;
      }
      const relative = path.join(owner.name, run.name);
      const absolute = path.join(base.rootReal, relative);
      if (activeRoots.has(absolute)) {
        continue;
      }
      let lease: { pid?: number; processIdentity?: string };
      try {
        lease = await base.readJson(path.join(relative, LEASE_FILE), { maxBytes: 1024 });
      } catch {
        if ((await base.list(relative)).length === 0) {
          await base.remove(relative);
        }
        continue;
      }
      if (
        !Number.isSafeInteger(lease.pid) ||
        lease.pid! < 1 ||
        typeof lease.processIdentity !== "string"
      ) {
        throw new Error("Invalid execution workspace lease; administrator cleanup required");
      }
      const reusedOwnPid = lease.pid === process.pid && lease.processIdentity !== processIdentity;
      if (!reusedOwnPid && processAlive(lease.pid!)) {
        continue;
      }
      await removeWorkspaceTree(base, relative);
      await base.remove(relative);
    }
  }
}

export async function registerHostWorkspace(storage: Root): Promise<() => void> {
  await storage.create(
    LEASE_FILE,
    JSON.stringify({ pid: process.pid, processIdentity, createdAt: Date.now() }),
  );
  return reserveHostWorkspace(storage.rootReal);
}
