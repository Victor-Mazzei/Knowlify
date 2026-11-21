import { access, readdir, stat, mkdir, rename, copyFile, rm, writeFile, realpath as resolveRealPath } from "node:fs/promises";
import { basename, extname, join, resolve, dirname, parse } from "node:path";
import { homedir } from "node:os";
import { isWithinRoot } from "../../domain/library/BrowseRoots.js";
import type { FileStore, Extracted } from "../../ports/index.js";
export class DiskFileStore implements FileStore {
  constructor(private booksDir: string, private coversDir: string) {}
  isWindows = process.platform === "win32";
  home = homedir();
  extension(path: string) { return extname(path).toLowerCase().slice(1); }
  title(path: string) { return basename(path, extname(path)); }
  join(...parts: string[]) { return join(...parts); }
  resolve(path: string) { return resolve(path); }
  realpath(path: string) { return resolveRealPath(path); }
  parent(path: string) { return dirname(path); }
  isRoot(path: string) { return dirname(path) === path || parse(path).root === path; }
  isDirectory(path: string) { return stat(path).then(s => s.isDirectory(), () => false); }
  accessible(path: string) { return access(path).then(() => true, () => false); }
  async entries(path: string) {
    return (await readdir(path, { withFileTypes: true })).map(e => ({ name: e.name, path: join(path, e.name), directory: e.isDirectory(), file: e.isFile(), symlink: e.isSymbolicLink() }));
  }
  async stat(path: string) { const s = await stat(path); return { size: s.size, mtime: Math.floor(s.mtimeMs) }; }
  async statIfExists(path: string) {
    try { return await this.stat(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only "the path is not there" is a confirmed absence. EACCES, EIO, ELOOP and a
      // vanished network mount must stay errors so callers keep the current state.
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
  }
  async removeManaged(path: string) {
    // Resolve every side before touching anything: a symlinked parent inside the managed
    // directory must not let the removal escape to a library folder.
    const [target, books, covers] = await Promise.all([
      this.realpath(path).catch(() => null),
      this.realpath(this.booksDir).catch(() => null),
      this.realpath(this.coversDir).catch(() => null),
    ]);
    if (!target) return false;
    const roots = [books, covers].filter((root): root is string => root !== null);
    // Never remove the managed directory itself; only descendants of it.
    if (!roots.some((root) => target !== root && isWithinRoot(root, target))) return false;
    await rm(path, { force: true });
    return true;
  }
  managedPath(id: string, format: string) { return join(this.booksDir, `${id}.${format}`); }
  async moveUpload(tmp: string, id: string, format: string) {
    await mkdir(this.booksDir, { recursive: true });
    await mkdir(this.coversDir, { recursive: true });
    const path = this.managedPath(id, format);
    await rename(tmp, path).catch(async () => { await copyFile(tmp, path); await rm(tmp, { force: true }); });
    return path;
  }
  async writeCover(id: string, cover: NonNullable<Extracted["cover"]>) {
    await mkdir(this.coversDir, { recursive: true });
    const path = join(this.coversDir, `${id}.${cover.ext}`);
    await writeFile(path, cover.data);
    return path;
  }
  async remove(path: string) { await rm(path, { force: true }); }
}
