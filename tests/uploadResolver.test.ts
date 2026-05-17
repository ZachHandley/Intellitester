import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

import {
  cleanupResolvedFiles,
  resolveUploadFiles,
} from '../src/executors/web/uploadResolver';

const tmpRoot = path.join(os.tmpdir(), `intellitester-upload-tests-${process.pid}`);
let yamlDir: string;
let yamlPath: string;
let fixturePath: string;

beforeAll(async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  yamlDir = await fs.mkdtemp(path.join(tmpRoot, 'yaml-'));
  yamlPath = path.join(yamlDir, 'test.yaml');
  await fs.writeFile(yamlPath, 'name: dummy\n', 'utf-8');
  fixturePath = path.join(yamlDir, 'fixture.txt');
  await fs.writeFile(fixturePath, 'hello from fixture', 'utf-8');
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const emptyVars = new Map<string, string>();

describe('resolveUploadFiles', () => {
  it('resolves a relative path against the test YAML directory', async () => {
    const result = await resolveUploadFiles('./fixture.txt', {
      testFilePath: yamlPath,
      variables: emptyVars,
    });
    expect(result).toEqual([{ kind: 'path', path: fixturePath }]);
  });

  it('passes an absolute path through unchanged', async () => {
    const result = await resolveUploadFiles(fixturePath, {
      testFilePath: yamlPath,
      variables: emptyVars,
    });
    expect(result).toEqual([{ kind: 'path', path: fixturePath }]);
  });

  it('throws a useful error when a referenced file is missing', async () => {
    await expect(
      resolveUploadFiles('./does-not-exist.txt', {
        testFilePath: yamlPath,
        variables: emptyVars,
      }),
    ).rejects.toThrow(/file not found/);
  });

  it('interpolates {{var}} in path strings', async () => {
    const vars = new Map<string, string>([['name', 'fixture.txt']]);
    const result = await resolveUploadFiles('./{{name}}', {
      testFilePath: yamlPath,
      variables: vars,
    });
    expect(result).toEqual([{ kind: 'path', path: fixturePath }]);
  });

  it('downloads a URL to a temp dir and returns the path + tempDir', async () => {
    const fakeBody = Buffer.from('downloaded body');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(fakeBody, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const result = await resolveUploadFiles('https://example.com/some/asset.png', {
      testFilePath: yamlPath,
      variables: emptyVars,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
    const entry = result[0];
    expect(entry.kind).toBe('path');
    if (entry.kind === 'path') {
      expect(entry.tempDir).toBeDefined();
      expect(path.basename(entry.path)).toBe('asset.png');
      const onDisk = await fs.readFile(entry.path);
      expect(onDisk.equals(fakeBody)).toBe(true);
      await cleanupResolvedFiles(result);
      await expect(fs.access(entry.tempDir!)).rejects.toThrow();
    }
    fetchSpy.mockRestore();
  });

  it('rejects when the URL responds non-2xx and cleans up nothing-yet', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('nope', { status: 404, statusText: 'Not Found' }),
    );
    await expect(
      resolveUploadFiles('https://example.com/missing', {
        testFilePath: yamlPath,
        variables: emptyVars,
      }),
    ).rejects.toThrow(/HTTP 404/);
    fetchSpy.mockRestore();
  });

  it('uses "download.bin" when the URL has no usable last segment', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(Buffer.from('x'), { status: 200 }),
    );
    const result = await resolveUploadFiles('https://example.com/', {
      testFilePath: yamlPath,
      variables: emptyVars,
    });
    const entry = result[0];
    if (entry.kind === 'path') {
      expect(path.basename(entry.path)).toBe('download.bin');
    }
    await cleanupResolvedFiles(result);
    fetchSpy.mockRestore();
  });

  it('decodes inline content as utf-8', async () => {
    const result = await resolveUploadFiles(
      [{ name: 'notes.txt', content: 'hi from yaml' }],
      { testFilePath: yamlPath, variables: emptyVars },
    );
    expect(result).toEqual([
      {
        kind: 'inline',
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('hi from yaml', 'utf-8'),
      },
    ]);
  });

  it('decodes inline base64', async () => {
    const raw = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const result = await resolveUploadFiles(
      [{ name: 'blob.bin', base64: raw.toString('base64') }],
      { testFilePath: yamlPath, variables: emptyVars },
    );
    const entry = result[0];
    expect(entry.kind).toBe('inline');
    if (entry.kind === 'inline') {
      expect(entry.buffer.equals(raw)).toBe(true);
      expect(entry.mimeType).toBe('application/octet-stream');
    }
  });

  it('derives mimeType from the filename extension when missing', async () => {
    const result = await resolveUploadFiles(
      [{ name: 'resume.pdf', content: '%PDF-1.4' }],
      { testFilePath: yamlPath, variables: emptyVars },
    );
    const entry = result[0];
    if (entry.kind === 'inline') {
      expect(entry.mimeType).toBe('application/pdf');
    }
  });

  it('honours an explicit mimeType on inline files', async () => {
    const result = await resolveUploadFiles(
      [{ name: 'a.bin', mimeType: 'image/jpeg', content: 'x' }],
      { testFilePath: yamlPath, variables: emptyVars },
    );
    const entry = result[0];
    if (entry.kind === 'inline') {
      expect(entry.mimeType).toBe('image/jpeg');
    }
  });

  it('interpolates {{var}} inside inline name + content', async () => {
    const vars = new Map<string, string>([
      ['fname', 'note.txt'],
      ['greeting', 'howdy'],
    ]);
    const result = await resolveUploadFiles(
      [{ name: '{{fname}}', content: '{{greeting}}, world' }],
      { testFilePath: yamlPath, variables: vars },
    );
    const entry = result[0];
    if (entry.kind === 'inline') {
      expect(entry.name).toBe('note.txt');
      expect(entry.buffer.toString('utf-8')).toBe('howdy, world');
    }
  });

  it('resolves an array of mixed types in order', async () => {
    const result = await resolveUploadFiles(
      [fixturePath, { name: 'b.txt', content: 'inline' }],
      { testFilePath: yamlPath, variables: emptyVars },
    );
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('path');
    expect(result[1].kind).toBe('inline');
  });

  it('cleanupResolvedFiles removes temp dirs from URL downloads only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(Buffer.from('x'), { status: 200 }),
    );
    const result = await resolveUploadFiles(
      ['https://example.com/y.txt', fixturePath],
      { testFilePath: yamlPath, variables: emptyVars },
    );
    const downloaded = result[0];
    expect(downloaded.kind).toBe('path');
    if (downloaded.kind !== 'path' || !downloaded.tempDir) throw new Error('expected temp download');
    await cleanupResolvedFiles(result);
    await expect(fs.access(downloaded.tempDir)).rejects.toThrow();
    // The real fixture must still be present.
    await fs.access(fixturePath);
    fetchSpy.mockRestore();
  });
});
