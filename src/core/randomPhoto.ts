/**
 * Generates a random photo URL from picsum.photos.
 *
 * @param dimensions - Optional dimensions in "WIDTHxHEIGHT" format (e.g., "500x500", "200x300")
 *                    Defaults to "500x500" if not provided.
 * @returns A URL like "https://picsum.photos/500/500"
 *
 * Examples:
 *   generateRandomPhoto()           -> "https://picsum.photos/500/500"
 *   generateRandomPhoto("200x300")  -> "https://picsum.photos/200/300"
 *   generateRandomPhoto("800")      -> "https://picsum.photos/800/800" (square)
 */
export function generateRandomPhoto(dimensions?: string): string {
  let width = 500;
  let height = 500;

  if (dimensions) {
    if (dimensions.includes('x')) {
      const [w, h] = dimensions.split('x').map((d) => parseInt(d.trim(), 10));
      if (!isNaN(w) && w > 0) width = w;
      if (!isNaN(h) && h > 0) height = h;
    } else {
      // Single number means square
      const size = parseInt(dimensions.trim(), 10);
      if (!isNaN(size) && size > 0) {
        width = size;
        height = size;
      }
    }
  }

  return `https://picsum.photos/${width}/${height}`;
}
