import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { interpolateVariables } from '../../core/interpolation';

/**
 * Inline synthetic file entry as it appears in a test YAML (after Zod parse).
 * One of `content` or `base64` is set; the validator guarantees XOR.
 */
export interface UploadInlineFile {
  name: string;
  mimeType?: string;
  content?: string;
  base64?: string;
}

export type UploadFileEntry = string | UploadInlineFile;

/** Resolved entry ready to feed Playwright's `setInputFiles` (or `FileChooser.setFiles`). */
export type ResolvedUploadFile =
  | { kind: 'path'; path: string; tempDir?: string }
  | { kind: 'inline'; name: string; mimeType: string; buffer: Buffer };

export interface ResolveContext {
  /** Absolute path to the test YAML file. Used to anchor relative `files` entries. */
  testFilePath?: string;
  /** Test-level variable bag for `${VAR}` interpolation. */
  variables: Map<string, string>;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function mimeFromName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

function deriveFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last && last.length > 0) return decodeURIComponent(last);
  } catch {
    // fall through
  }
  return 'download.bin';
}

async function downloadUrl(url: string): Promise<{ path: string; tempDir: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`upload: failed to download ${url} (HTTP ${response.status} ${response.statusText})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const name = deriveFilenameFromUrl(url);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'intellitester-upload-'));
  const tempPath = path.join(tempDir, name);
  await fs.writeFile(tempPath, buffer);
  return { path: tempPath, tempDir };
}

async function resolveOne(
  entry: UploadFileEntry,
  context: ResolveContext,
): Promise<ResolvedUploadFile> {
  if (typeof entry === 'string') {
    const interpolated = interpolateVariables(entry, context.variables);
    if (/^https?:\/\//i.test(interpolated)) {
      const downloaded = await downloadUrl(interpolated);
      return { kind: 'path', path: downloaded.path, tempDir: downloaded.tempDir };
    }

    const absolute = path.isAbsolute(interpolated)
      ? interpolated
      : path.resolve(
          context.testFilePath ? path.dirname(context.testFilePath) : process.cwd(),
          interpolated,
        );

    try {
      await fs.access(absolute);
    } catch {
      throw new Error(`upload: file not found at ${absolute} (from "${interpolated}")`);
    }
    return { kind: 'path', path: absolute };
  }

  // Inline synthetic file. Zod guarantees exactly one of content/base64.
  const name = interpolateVariables(entry.name, context.variables);
  const mimeType = entry.mimeType ?? mimeFromName(name);
  let buffer: Buffer;
  if (entry.base64 !== undefined) {
    const interpolated = interpolateVariables(entry.base64, context.variables);
    buffer = Buffer.from(interpolated, 'base64');
  } else {
    const interpolated = interpolateVariables(entry.content ?? '', context.variables);
    buffer = Buffer.from(interpolated, 'utf-8');
  }
  return { kind: 'inline', name, mimeType, buffer };
}

/**
 * Resolve every entry in the test YAML's `files` field to a value Playwright
 * can consume. URL entries are downloaded to a temp directory; the caller is
 * responsible for calling `cleanupResolvedFiles` once the upload is done.
 */
export async function resolveUploadFiles(
  files: UploadFileEntry | UploadFileEntry[],
  context: ResolveContext,
): Promise<ResolvedUploadFile[]> {
  const entries = Array.isArray(files) ? files : [files];
  const resolved: ResolvedUploadFile[] = [];
  try {
    for (const entry of entries) {
      resolved.push(await resolveOne(entry, context));
    }
    return resolved;
  } catch (e) {
    // Best-effort cleanup of anything that landed in tmp before the failure.
    await cleanupResolvedFiles(resolved).catch(() => undefined);
    throw e;
  }
}

/** Shape Playwright accepts for `setInputFiles` / `FileChooser.setFiles`. */
export interface PlaywrightFilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * Convert resolved files to Playwright's uniform `FilePayload[]` shape. Reads
 * any path-kind entries off disk so the resulting array is homogeneous (mixed
 * `string | FilePayload` arrays are not accepted by `setInputFiles`).
 */
export async function toPlaywrightFiles(
  resolved: ResolvedUploadFile[],
): Promise<PlaywrightFilePayload[]> {
  return Promise.all(
    resolved.map(async (r) => {
      if (r.kind === 'inline') {
        return { name: r.name, mimeType: r.mimeType, buffer: r.buffer };
      }
      const buffer = await fs.readFile(r.path);
      return {
        name: path.basename(r.path),
        mimeType: mimeFromName(r.path),
        buffer,
      };
    }),
  );
}

/** Remove temp directories created by URL downloads. Real-disk paths are left alone. */
export async function cleanupResolvedFiles(resolved: ResolvedUploadFile[]): Promise<void> {
  const tempDirs = new Set<string>();
  for (const r of resolved) {
    if (r.kind === 'path' && r.tempDir) tempDirs.add(r.tempDir);
  }
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
