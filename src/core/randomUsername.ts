import {
  uniqueNamesGenerator,
  adjectives,
  animals,
  NumberDictionary,
} from 'unique-names-generator';

/**
 * Generates a random username in PascalCase format.
 * Format: AdjectiveAnimalNN (e.g., "HappyTiger42", "BlueFox07")
 *
 * The username is designed to:
 * - Be human-readable and memorable
 * - Stay under 30 characters (typical username validation limit)
 * - Include a 2-digit suffix for uniqueness
 *
 * Examples: "HappyTiger42", "BlueFox07", "QuickBear91"
 */
export function generateRandomUsername(): string {
  // Generate 2-digit number for suffix (00-99)
  const numberDictionary = NumberDictionary.generate({ min: 0, max: 99 });

  const username = uniqueNamesGenerator({
    dictionaries: [adjectives, animals, numberDictionary],
    separator: '',
    style: 'capital',
    length: 3,
  });

  // Ensure we stay under 30 characters
  // Most adjective+animal combos are well under this, but truncate if needed
  if (username.length > 30) {
    return username.slice(0, 30);
  }

  return username;
}
