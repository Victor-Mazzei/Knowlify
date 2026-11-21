import { basename, isAbsolute, relative, sep } from "node:path";

export interface BrowseRootEntry {
  name: string;
  path: string;
}

/**
 * True when `path` is `root` itself or one of its descendants. Both paths must already be
 * canonical (realpath), so a symlink cannot smuggle a folder out of the allowlist. The
 * `relative` comparison is segment-aware on purpose: `/library2` is not inside `/library`.
 */
export function isWithinRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  // Different Windows drives produce an absolute relative path instead of `..`.
  return !isAbsolute(rel);
}

/**
 * Allowlist for the folder browser and for newly added sources (ADR-10). An empty list
 * means unrestricted, the historical behaviour outside the Docker image.
 */
export class BrowseRoots {
  constructor(
    private readonly configured: readonly string[],
    private readonly realpath: (path: string) => Promise<string>,
  ) {}

  get restricted(): boolean {
    return this.configured.length > 0;
  }

  /** Canonical existing roots. A configured root that is not mounted is not offered. */
  async list(): Promise<BrowseRootEntry[]> {
    const seen = new Set<string>();
    const roots: BrowseRootEntry[] = [];
    for (const configured of this.configured) {
      const path = await this.realpath(configured).catch(() => null);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      roots.push({ name: basename(path) || path, path });
    }
    return roots;
  }

  /** Containment check for an already resolved path. Unrestricted allows every path. */
  async contains(path: string): Promise<boolean> {
    if (!this.restricted) return true;
    return (await this.list()).some((root) => isWithinRoot(root.path, path));
  }
}
