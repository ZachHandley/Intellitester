import { describe, it, expect } from 'vitest';
import { cssEscape } from '../src/executors/web/cssEscape';

describe('cssEscape', () => {
  it('passes through plain alphanumeric identifiers unchanged', () => {
    expect(cssEscape('library-new-job')).toBe('library-new-job');
    expect(cssEscape('foo_bar123')).toBe('foo_bar123');
  });

  it('escapes a leading digit', () => {
    expect(cssEscape('1col')).toBe('\\31 col');
  });

  it('escapes a leading hyphen followed by a digit', () => {
    expect(cssEscape('-1col')).toBe('-\\31 col');
  });

  it('escapes a single hyphen', () => {
    expect(cssEscape('-')).toBe('\\-');
  });

  it('replaces the null byte with U+FFFD', () => {
    expect(cssEscape('a\x00b')).toBe('a�b');
  });

  it('escapes ASCII control characters', () => {
    expect(cssEscape('a\x01b')).toBe('a\\1 b');
    expect(cssEscape('a\x7fb')).toBe('a\\7f b');
  });

  it('escapes special punctuation', () => {
    expect(cssEscape('a.b')).toBe('a\\.b');
    expect(cssEscape('a#b')).toBe('a\\#b');
    expect(cssEscape('a:b')).toBe('a\\:b');
  });

  it('passes through non-ASCII characters unchanged', () => {
    expect(cssEscape('café')).toBe('café');
    expect(cssEscape('日本語')).toBe('日本語');
  });

  it('handles the empty string', () => {
    expect(cssEscape('')).toBe('');
  });
});
