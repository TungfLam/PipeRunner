import fs from "fs/promises";
import path from "path";
import type { Express } from "express";
import { env } from "../config/env";
import type { StoredFile } from "../types/domain";
import { HttpError } from "../utils/httpError";
import { previewTypeForPath } from "../utils/preview";

function toPosix(filePath: string) {
  return filePath.split(path.sep).join("/");
}

function timestampSlug(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

export function sanitizeFileName(fileName: string) {
  const baseName = path.basename(fileName);
  const cleaned = baseName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || `file_${Date.now()}`;
}

export class FileStorageService {
  async ensureRoot() {
    await fs.mkdir(env.DATA_ROOT, { recursive: true });
  }

  resolveRelativePath(relativePath: string) {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new HttpError(400, "Path must be relative to DATA_ROOT");
    }

    const normalized = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
    const absolutePath = path.resolve(env.DATA_ROOT, normalized);
    const dataRoot = path.resolve(env.DATA_ROOT);
    if (absolutePath !== dataRoot && !absolutePath.startsWith(`${dataRoot}${path.sep}`)) {
      throw new HttpError(400, "Path escapes DATA_ROOT");
    }

    return absolutePath;
  }

  relativeFromAbsolute(absolutePath: string) {
    const resolved = path.resolve(absolutePath);
    const dataRoot = path.resolve(env.DATA_ROOT);
    if (resolved !== dataRoot && !resolved.startsWith(`${dataRoot}${path.sep}`)) {
      throw new HttpError(500, "Stored file path escapes DATA_ROOT");
    }
    return toPosix(path.relative(dataRoot, resolved));
  }

  assertUserOwnsPath(userId: string, relativePath: string) {
    const normalized = toPosix(path.normalize(relativePath));
    if (!normalized.startsWith(`users/${userId}/`)) {
      throw new HttpError(403, "File is outside the current user scope");
    }
  }

  async createProjectFilesDir(userId: string, projectId: string) {
    const dir = path.join(env.DATA_ROOT, "users", userId, "projects", projectId, "files");
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async createRunDirs(userId: string, projectId: string, runId: string) {
    const folderName = `${timestampSlug()}_${runId}`;
    const runDir = path.join(env.DATA_ROOT, "users", userId, "projects", projectId, "runs", folderName);
    const inputDir = path.join(runDir, "input");
    const outputDir = path.join(runDir, "output");
    const tempDir = path.join(runDir, "temp");
    const logsDir = path.join(runDir, "logs");
    await Promise.all([inputDir, outputDir, tempDir, logsDir].map((dir) => fs.mkdir(dir, { recursive: true })));
    return { runDir, inputDir, outputDir, tempDir, logsDir };
  }

  async saveProjectUpload(userId: string, projectId: string, file: Express.Multer.File): Promise<StoredFile> {
    const dir = await this.createProjectFilesDir(userId, projectId);
    const safeName = `${Date.now()}_${sanitizeFileName(file.originalname)}`;
    const absolutePath = path.join(dir, safeName);
    await fs.writeFile(absolutePath, file.buffer);
    const relativePath = this.relativeFromAbsolute(absolutePath);
    return {
      name: safeName,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      relativePath,
      preview: previewTypeForPath(safeName)
    };
  }

  async saveRunUpload(inputDir: string, inputName: string, file: Express.Multer.File): Promise<StoredFile> {
    const safeName = `${sanitizeFileName(inputName)}_${sanitizeFileName(file.originalname)}`;
    const absolutePath = path.join(inputDir, safeName);
    await fs.writeFile(absolutePath, file.buffer);
    return {
      name: inputName,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      relativePath: this.relativeFromAbsolute(absolutePath),
      preview: previewTypeForPath(safeName)
    };
  }

  async copySelectedInput(userId: string, sourceRelativePath: string, inputDir: string, inputName: string): Promise<StoredFile> {
    this.assertUserOwnsPath(userId, sourceRelativePath);
    const sourceAbsolutePath = this.resolveRelativePath(sourceRelativePath);
    const sourceStat = await fs.stat(sourceAbsolutePath);
    if (!sourceStat.isFile()) {
      throw new HttpError(400, "Selected input path is not a file");
    }

    const safeName = `${sanitizeFileName(inputName)}_${sanitizeFileName(path.basename(sourceRelativePath))}`;
    const destination = path.join(inputDir, safeName);
    await fs.copyFile(sourceAbsolutePath, destination);
    return {
      name: inputName,
      originalName: path.basename(sourceRelativePath),
      size: sourceStat.size,
      relativePath: this.relativeFromAbsolute(destination),
      preview: previewTypeForPath(safeName)
    };
  }

  async listFilesUnder(userId: string, relativeDir: string): Promise<StoredFile[]> {
    this.assertUserOwnsPath(userId, relativeDir.endsWith("/") ? relativeDir : `${relativeDir}/`);
    const baseAbsolute = this.resolveRelativePath(relativeDir);
    const results: StoredFile[] = [];

    async function walk(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          const absolutePath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(absolutePath);
            return;
          }
          if (!entry.isFile()) {
            return;
          }
          const stat = await fs.stat(absolutePath);
          const relativePath = toPosix(path.relative(env.DATA_ROOT, absolutePath));
          results.push({
            name: entry.name,
            size: stat.size,
            relativePath,
            preview: previewTypeForPath(entry.name)
          });
        })
      );
    }

    try {
      await walk(baseAbsolute);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  async readText(relativePath: string, maxBytes = 2_000_000) {
    const absolutePath = this.resolveRelativePath(relativePath);
    const stat = await fs.stat(absolutePath);
    if (stat.size > maxBytes) {
      throw new HttpError(413, "File is too large to preview as text");
    }
    return fs.readFile(absolutePath, "utf8");
  }

  async writeManifest(runDir: string, manifest: unknown) {
    await fs.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  async removeRelativePath(userId: string, relativePath: string) {
    this.assertUserOwnsPath(userId, relativePath.endsWith("/") ? relativePath : `${relativePath}/`);
    const absolutePath = this.resolveRelativePath(relativePath);
    await fs.rm(absolutePath, { recursive: true, force: true });
  }

  async estimateRelativePathSize(userId: string, relativePath: string) {
    this.assertUserOwnsPath(userId, relativePath.endsWith("/") ? relativePath : `${relativePath}/`);
    const absolutePath = this.resolveRelativePath(relativePath);

    async function walk(entryPath: string): Promise<number> {
      let stat;
      try {
        stat = await fs.stat(entryPath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return 0;
        }
        throw error;
      }

      if (stat.isFile()) {
        return stat.size;
      }
      if (!stat.isDirectory()) {
        return 0;
      }

      const entries = await fs.readdir(entryPath, { withFileTypes: true });
      const sizes = await Promise.all(entries.map((entry) => walk(path.join(entryPath, entry.name))));
      return sizes.reduce((total, size) => total + size, 0);
    }

    return walk(absolutePath);
  }
}

export const fileStorageService = new FileStorageService();
