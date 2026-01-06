import crypto from 'node:crypto';
import { generateRandomUsername } from './randomUsername';
import { generateRandomPhoto } from './randomPhoto';
import { generateFillerText } from './fillerText';
import { generateRandomEmail } from './randomEmail';
import { generateRandomPhone } from './randomPhone';

/**
 * Built-in variable interpolation for test values.
 *
 * Supports the following patterns:
 * - {{uuid}} - Short UUID (first segment of a UUID v4)
 * - {{randomUsername}} - Random username like "HappyTiger42"
 * - {{randomPhoto}} - Random photo URL (500x500 default)
 * - {{randomPhoto:WxH}} - Random photo with custom dimensions (e.g., {{randomPhoto:200x300}})
 * - {{fillerText}} - Lorem ipsum filler text (~50 words default)
 * - {{fillerText:N}} - Lorem ipsum with N words (e.g., {{fillerText:100}})
 * - {{randomEmail}} - Random test email (e.g., test-abc123@test.local)
 * - {{randomEmail:domain}} - Random email with custom domain (e.g., {{randomEmail:example.com}})
 * - {{randomPhone}} - Random valid phone number in E.164 format (default: US)
 * - {{randomPhone:CC}} - Random phone for country code (e.g., {{randomPhone:GB}})
 * - {{varName}} - User-defined variable from context
 *
 * @param value - The string containing {{variable}} placeholders
 * @param variables - Map of user-defined variables
 * @returns The interpolated string with all placeholders replaced
 */
export function interpolateVariables(
  value: string,
  variables: Map<string, string>
): string {
  // Match {{name}} or {{name:param}} patterns
  // The regex captures: full match, name, optional parameter (after colon)
  return value.replace(/\{\{(\w+)(?::([^}]+))?\}\}/g, (match, name, param) => {
    switch (name) {
      case 'uuid':
        return crypto.randomUUID().split('-')[0];

      case 'randomUsername':
        return generateRandomUsername();

      case 'randomPhoto':
        return generateRandomPhoto(param);

      case 'fillerText':
        return generateFillerText(param);

      case 'randomEmail':
        return generateRandomEmail(param);

      case 'randomPhone':
        return generateRandomPhone(param);

      default:
        // Check user-defined variables
        return variables.get(name) ?? match;
    }
  });
}

/**
 * Export individual generators for direct use if needed.
 */
export { generateRandomUsername } from './randomUsername';
export { generateRandomPhoto } from './randomPhoto';
export { generateFillerText } from './fillerText';
export { generateRandomEmail } from './randomEmail';
export { generateRandomPhone } from './randomPhone';
