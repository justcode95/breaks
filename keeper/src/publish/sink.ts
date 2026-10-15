import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PublishedFile } from "./files.js";

/** Where published files go. Writing the same file again is a no-op; a different file under the same name is an error. */
export interface FileSink {
  exists(path: string): Promise<boolean>;
  write(file: PublishedFile): Promise<"written" | "present">;
}

/** A file is already there under this name with other content. Names are hashes, so this should never happen. */
export class PublishedMismatch extends Error {
  constructor(path: string) {
    super(`${path} already exists with different content; it is left as it is`);
    this.name = "PublishedMismatch";
  }
}

/** Only the names `files.ts` makes: a folder, 64 hex digits and the folder's extension. Nothing else is written, whatever is asked. */
const NAME = /^(?:(?:eligibility|pool)\/[0-9a-f]{64}\.json|inputs\/[0-9a-f]{64}\.txt)$/;

/** Writes into a directory a web server (or anything else) serves. A file appears whole or not at all. */
export class DirSink implements FileSink {
  constructor(private readonly dir: string) {}

  private resolve(path: string): string {
    if (!NAME.test(path)) throw new Error(`not a published file name: ${path}`);
    return join(this.dir, path);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.read(path)) !== undefined;
  }

  private async read(path: string): Promise<string | undefined> {
    try {
      return await readFile(this.resolve(path), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async write(file: PublishedFile): Promise<"written" | "present"> {
    const target = this.resolve(file.path);
    const existing = await this.read(file.path);
    if (existing !== undefined) {
      if (existing === file.body) return "present";
      throw new PublishedMismatch(file.path);
    }
    await mkdir(dirname(target), { recursive: true });
    // Written next to its name and renamed into place, so a reader never sees half a file.
    const temp = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(temp, file.body, { encoding: "utf8", flag: "wx" });
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    return "written";
  }
}
