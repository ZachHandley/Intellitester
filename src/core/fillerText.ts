/**
 * Lorem ipsum word list for generating filler text.
 * Using a curated list of Latin-style words commonly found in lorem ipsum generators.
 */
const LOREM_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
  'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
  'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate',
  'velit', 'esse', 'cillum', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint',
  'occaecat', 'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia',
  'deserunt', 'mollit', 'anim', 'id', 'est', 'laborum', 'perspiciatis', 'unde',
  'omnis', 'iste', 'natus', 'error', 'voluptatem', 'accusantium', 'doloremque',
  'laudantium', 'totam', 'rem', 'aperiam', 'eaque', 'ipsa', 'quae', 'ab', 'illo',
  'inventore', 'veritatis', 'quasi', 'architecto', 'beatae', 'vitae', 'dicta',
  'explicabo', 'nemo', 'ipsam', 'quia', 'voluptas', 'aspernatur', 'aut', 'odit',
  'fugit', 'consequuntur', 'magni', 'dolores', 'eos', 'ratione', 'sequi',
  'nesciunt', 'neque', 'porro', 'quisquam', 'nihil', 'impedit', 'quo', 'minus',
];

/**
 * Generates lorem ipsum style filler text.
 *
 * @param wordCount - Number of words to generate. Defaults to 50.
 * @returns A string of lorem ipsum style filler text.
 *
 * Examples:
 *   generateFillerText()      -> ~50 words of lorem ipsum
 *   generateFillerText(10)    -> ~10 words of lorem ipsum
 *   generateFillerText(100)   -> ~100 words of lorem ipsum
 */
export function generateFillerText(wordCount?: number | string): string {
  let count = 50;

  if (wordCount !== undefined) {
    const parsed = typeof wordCount === 'string' ? parseInt(wordCount.trim(), 10) : wordCount;
    if (!isNaN(parsed) && parsed > 0) {
      count = parsed;
    }
  }

  const words: string[] = [];

  // Start with "Lorem ipsum" for authenticity if we have enough words
  if (count >= 2) {
    words.push('Lorem', 'ipsum');
    count -= 2;
  }

  for (let i = 0; i < count; i++) {
    const randomIndex = Math.floor(Math.random() * LOREM_WORDS.length);
    words.push(LOREM_WORDS[randomIndex]);
  }

  // Join and add basic punctuation for readability
  let result = words.join(' ');

  // Add periods roughly every 8-12 words for sentence structure
  const resultWords = result.split(' ');
  const sentenceWords: string[] = [];
  let sentenceLength = 0;
  const nextSentenceLength = () => 8 + Math.floor(Math.random() * 5);
  let targetLength = nextSentenceLength();

  for (let i = 0; i < resultWords.length; i++) {
    let word = resultWords[i];

    // Capitalize first word of sentence
    if (sentenceLength === 0) {
      word = word.charAt(0).toUpperCase() + word.slice(1);
    }

    sentenceWords.push(word);
    sentenceLength++;

    // Add period if we've reached sentence length
    if (sentenceLength >= targetLength && i < resultWords.length - 1) {
      sentenceWords[sentenceWords.length - 1] += '.';
      sentenceLength = 0;
      targetLength = nextSentenceLength();
    }
  }

  // Ensure the text ends with a period
  result = sentenceWords.join(' ');
  if (!result.endsWith('.')) {
    result += '.';
  }

  return result;
}
