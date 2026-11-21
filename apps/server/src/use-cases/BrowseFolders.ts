import type { FileStore } from "../ports/index.js";
import { ValidationError } from "../domain/errors.js";
import { BrowseRoots } from "../domain/library/BrowseRoots.js";

interface Entry {
  name: string;
  path: string;
}

interface Listing {
  path: string;
  parent: string | null;
  entries: Entry[];
  books: number;
  restricted: boolean;
}

export class BrowseFolders {
  private readonly roots: BrowseRoots;
  constructor(private files: FileStore, private libraryPaths: string[], browseRoots: string[] = []) {
    this.roots = new BrowseRoots(browseRoots, (path) => files.realpath(path));
  }
  private async startPath(): Promise<string> {
    for (const path of [...this.libraryPaths, "/library", this.files.home]) {
      if (path && await this.files.isDirectory(path)) return this.files.resolve(path);
    }
    return this.files.resolve("/");
  }
  async execute(input?: string): Promise<Listing> {
    const requested = input?.trim();
    if (this.roots.restricted) return this.browseAllowed(requested);
    if (this.files.isWindows && requested === "") {
      const entries: Entry[] = [];
      for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        const path = `${letter}:\\`;
        if (await this.files.accessible(path)) entries.push({ name: path, path });
      }
      return { path: "", parent: null, entries, books: 0, restricted: false };
    }
    return this.list(this.files.resolve(requested || await this.startPath()), null);
  }
  private async browseAllowed(requested?: string): Promise<Listing> {
    const roots = await this.roots.list();
    if (!requested) {
      if (roots.length === 1) return this.list(roots[0]!.path, roots[0]!.path);
      return { path: "", parent: null, entries: roots, books: 0, restricted: true };
    }
    const path = await this.files.realpath(requested).catch(() => null);
    if (!path) throw new ValidationError("Not a folder, or not readable by the server");
    if (!await this.roots.contains(path)) throw new ValidationError("This folder is outside the folders Knowlify may browse");
    return this.list(path, roots.find((root) => root.path === path)?.path ?? null);
  }
  private async list(path: string, rootPath: string | null): Promise<Listing> {
    if (!await this.files.isDirectory(path)) throw new ValidationError("Not a folder, or not readable by the server");
    let items;
    try { items = await this.files.entries(path); }
    catch { throw new ValidationError("The server cannot read this folder (permission denied)"); }
    const entries: Entry[] = [];
    let books = 0;
    for (const item of items) {
      if (/\.(pdf|epub)$/i.test(item.name) && item.file) books++;
      if (item.name.startsWith(".")) continue;
      if (item.directory || (item.symlink && await this.files.isDirectory(item.path))) entries.push({ name: item.name, path: item.path });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    const parent = this.files.isRoot(path) ? (this.files.isWindows ? "" : null)
      : path === rootPath ? null
      : this.files.parent(path);
    return { path, parent, entries, books, restricted: this.roots.restricted };
  }
}
