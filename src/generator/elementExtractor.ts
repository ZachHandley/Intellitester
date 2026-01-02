/**
 * Element extractor for parsing interactive elements from component templates
 */

export interface ElementInfo {
  /** HTML tag name (button, input, a, etc.) */
  tag: string;
  /** data-testid attribute */
  testId?: string;
  /** Inner text or label */
  text?: string;
  /** ARIA role */
  role?: string;
  /** Accessible name (aria-label) */
  name?: string;
  /** Input type */
  type?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Which page/route this element is on */
  route?: string;
  /** Human-readable description */
  description?: string;
  /** Source file path */
  file: string;
}

/**
 * Interactive HTML elements we're interested in extracting
 */
const INTERACTIVE_TAGS = [
  'button',
  'input',
  'textarea',
  'select',
  'a',
  'form',
  'label',
  'option',
] as const;

/**
 * Extract template content based on file type
 */
function extractTemplateContent(content: string, filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'vue': {
      // Extract from <template> section
      const templateMatch = content.match(/<template[^>]*>([\s\S]*?)<\/template>/);
      return templateMatch ? templateMatch[1] : '';
    }

    case 'astro': {
      // Astro files: content after frontmatter (---)
      const frontmatterEnd = content.lastIndexOf('---');
      if (frontmatterEnd > 0) {
        return content.substring(frontmatterEnd + 3);
      }
      return content;
    }

    case 'tsx':
    case 'jsx': {
      // Extract JSX from return statements
      const jsxPatterns = [
        // return ( ... )
        /return\s*\(([\s\S]*?)\);/g,
        // return <...>
        /return\s+(<[\s\S]*?>[\s\S]*?<\/[\w.]+>)/g,
        // return <... />
        /return\s+(<[^>]+\/\s*>)/g,
      ];

      const jsxParts: string[] = [];
      for (const pattern of jsxPatterns) {
        const matches = content.matchAll(pattern);
        for (const match of matches) {
          jsxParts.push(match[1]);
        }
      }

      return jsxParts.join('\n');
    }

    case 'svelte': {
      // Svelte: HTML-like template (whole file minus script/style)
      let template = content;

      // Remove <script> blocks
      template = template.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');

      // Remove <style> blocks
      template = template.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');

      return template;
    }

    default:
      return content;
  }
}

/**
 * Extract attribute value from an element string
 */
function extractAttribute(element: string, attrName: string): string | undefined {
  // Handle both quoted and unquoted attributes
  const patterns = [
    new RegExp(`${attrName}\\s*=\\s*"([^"]*)"`, 'i'),
    new RegExp(`${attrName}\\s*=\\s*'([^']*)'`, 'i'),
    new RegExp(`${attrName}\\s*=\\s*\{([^}]*)\}`, 'i'), // JSX expressions
  ];

  for (const pattern of patterns) {
    const match = element.match(pattern);
    if (match && match[1]) {
      // Clean up JSX expressions
      let value = match[1].trim();

      // Remove common JSX wrapper patterns like `"string"` or 't("key")'
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }

      return value;
    }
  }

  return undefined;
}

/**
 * Extract text content from an element
 */
function extractTextContent(element: string, tag: string): string | undefined {
  // Match opening tag to closing tag
  const regex = new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, 'i');
  const match = element.match(regex);

  if (match && match[1]) {
    let text = match[1].trim();

    // Remove common JSX expressions
    text = text.replace(/\{[^}]*\}/g, '').trim();

    // Only return if there's actual text content
    if (text.length > 0 && text.length < 100) {
      return text;
    }
  }

  return undefined;
}

/**
 * Generate a human-readable description for an element
 */
function generateDescription(element: Partial<ElementInfo>): string {
  const parts: string[] = [];

  // Start with tag
  if (element.tag === 'input' && element.type) {
    parts.push(`${element.type} input`);
  } else if (element.tag === 'a') {
    parts.push('link');
  } else if (element.tag) {
    parts.push(element.tag);
  }

  // Add identifying information
  if (element.text) {
    parts.push(`"${element.text}"`);
  } else if (element.name) {
    parts.push(`"${element.name}"`);
  } else if (element.placeholder) {
    parts.push(`with placeholder "${element.placeholder}"`);
  } else if (element.testId) {
    parts.push(`(${element.testId})`);
  }

  return parts.join(' ');
}

/**
 * Parse a single element string and extract its information
 */
function parseElement(
  elementStr: string,
  file: string,
  route?: string,
): ElementInfo | null {
  // Extract tag name
  const tagMatch = elementStr.match(/<(\w+)/);
  if (!tagMatch) return null;

  const tag = tagMatch[1].toLowerCase();

  // Only process interactive elements
  if (!INTERACTIVE_TAGS.includes(tag as any)) {
    return null;
  }

  const element: Partial<ElementInfo> = {
    tag,
    file,
    route,
  };

  // Extract attributes
  element.testId = extractAttribute(elementStr, 'data-testid');
  element.role = extractAttribute(elementStr, 'role');
  element.name = extractAttribute(elementStr, 'aria-label');
  element.type = extractAttribute(elementStr, 'type');
  element.placeholder = extractAttribute(elementStr, 'placeholder');

  // Also check for 'name' attribute if no aria-label
  if (!element.name) {
    element.name = extractAttribute(elementStr, 'name');
  }

  // Extract text content for buttons, links, labels
  if (['button', 'a', 'label', 'option'].includes(tag)) {
    element.text = extractTextContent(elementStr, tag);
  }

  // Generate description
  element.description = generateDescription(element);

  return element as ElementInfo;
}

/**
 * Extract all interactive elements from component content
 */
export function extractElements(
  content: string,
  filePath: string,
  route?: string,
): ElementInfo[] {
  // Extract template content based on framework
  const template = extractTemplateContent(content, filePath);

  if (!template.trim()) {
    return [];
  }

  const elements: ElementInfo[] = [];

  // Find all element tags
  // This regex matches opening tags with their attributes (including self-closing)
  const elementPattern = /<(\w+)(?:\s+[^>]*)?(?:\/>|>[\s\S]*?<\/\1>)/g;
  const matches = template.matchAll(elementPattern);

  for (const match of matches) {
    const elementStr = match[0];
    const element = parseElement(elementStr, filePath, route);

    if (element) {
      elements.push(element);
    }
  }

  return elements;
}
