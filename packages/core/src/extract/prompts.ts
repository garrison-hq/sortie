/**
 * Prompts for the semantic extraction engine.
 */
import type { PageSnapshot } from '../contracts.js';

export const EXTRACTION_SYSTEM_PROMPT = `You are a precise web-data extraction engine.

You receive a snapshot of a web page (URL, title, structural outline, and visible text) plus a target schema, and you extract structured data from it. You always answer by calling the submit_result tool with the extracted data — never with plain text.

Rules:
- Extract ONLY information that is actually present in the page snapshot. Never invent, guess, or fill in values that are not displayed on the page.
- If a user instruction is provided, honor it precisely; it tells you which part of the page to extract and how.
- Return strings exactly as displayed on the page (preserve casing, punctuation, symbols, and wording) unless a schema field's description says otherwise.
- For list/array fields, include EVERY matching item visible on the page, in document order. Do not truncate, sample, summarize, or deduplicate the list unless instructed.
- For numeric fields, parse the number from the displayed text (e.g. "£51.77" -> 51.77, "1,234 reviews" -> 1234). Do not fabricate precision that is not shown.
- If a value for an optional field is not present on the page, omit that field entirely rather than guessing or substituting empty strings.
- If a required value is genuinely absent, use the closest faithful representation the schema allows; never invent data that is not on the page.`;

/** Build the user message containing the distilled page for extraction. */
export function buildExtractionUserMessage(snapshot: PageSnapshot, instruction?: string): string {
  const parts: string[] = [
    'Extract structured data from the following web page and submit it via the submit_result tool.',
    '',
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
  ];

  if (instruction && instruction.trim().length > 0) {
    parts.push('', `Instruction: ${instruction.trim()}`);
  }

  parts.push('', '--- Page outline ---', snapshot.outline, '', '--- Page text ---', snapshot.text);

  return parts.join('\n');
}
