import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface PixelDiffOptions {
  /** Per-pixel sensitivity (0..1). Smaller = stricter. pixelmatch default 0.1. */
  threshold?: number;
  /** Treat anti-aliased pixels as matches (default true). */
  ignoreAntialiasing?: boolean;
}

export interface PixelDiffResult {
  diffPixels: number;
  totalPixels: number;
  ratio: number;
  /** Diff overlay PNG (same dimensions as inputs). Only populated when both inputs decoded successfully. */
  diffPng: Buffer;
  width: number;
  height: number;
}

export class PixelDiffSizeError extends Error {
  constructor(
    public readonly aWidth: number,
    public readonly aHeight: number,
    public readonly bWidth: number,
    public readonly bHeight: number,
  ) {
    super(
      `pixel diff: image dimensions differ (${aWidth}x${aHeight} vs ${bWidth}x${bHeight}). ` +
      `Element size changed between measurement and assertion — treat this as a real change ` +
      `(use a geometry comparator like grew/shrank/moved) rather than a pixel diff.`,
    );
    this.name = 'PixelDiffSizeError';
  }
}

/**
 * Pixel-diff two element-scoped PNGs. Both buffers must encode images of the
 * same dimensions; mismatched sizes throw `PixelDiffSizeError` (a size change
 * is a structural difference, not the kind of thing pixelmatch is designed for).
 */
export function diffPngBuffers(
  actual: Buffer,
  expected: Buffer,
  options: PixelDiffOptions = {},
): PixelDiffResult {
  const a = PNG.sync.read(actual);
  const b = PNG.sync.read(expected);

  if (a.width !== b.width || a.height !== b.height) {
    throw new PixelDiffSizeError(a.width, a.height, b.width, b.height);
  }

  const { width, height } = a;
  const diff = new PNG({ width, height });

  const diffPixels = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: options.threshold ?? 0.1,
    includeAA: options.ignoreAntialiasing === false,
  });

  const totalPixels = width * height;
  return {
    diffPixels,
    totalPixels,
    ratio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    diffPng: PNG.sync.write(diff),
    width,
    height,
  };
}
