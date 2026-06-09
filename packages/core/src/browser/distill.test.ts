import { describe, expect, it } from 'vitest';
import type { Page, Locator } from 'playwright';
import type { DistilledElement } from '../contracts.js';
import { buildOutline, resolveRef } from './distill.js';

describe('buildOutline', () => {
  it('returns an empty string for an empty element list without throwing', () => {
    expect(buildOutline([])).toBe('');
  });

  it('formats interactive elements with ref, role, and name', () => {
    const elements: DistilledElement[] = [
      { ref: 'e1', role: 'link', name: 'Home', tag: 'a', href: 'https://example.com/' },
      { ref: 'e2', role: 'button', name: 'Submit', tag: 'button' },
    ];
    const outline = buildOutline(elements);
    expect(outline).toBe('[e1] link "Home" -> https://example.com/\n[e2] button "Submit"');
  });

  it('formats headings without a ref handle', () => {
    const outline = buildOutline([{ ref: 'e1', role: 'heading', name: 'Products', tag: 'h1' }]);
    expect(outline).toBe('## heading "Products"');
  });

  it('annotates value, checked, and disabled states', () => {
    const elements: DistilledElement[] = [
      { ref: 'e1', role: 'textbox', name: 'Search', tag: 'input', value: 'fish' },
      { ref: 'e2', role: 'checkbox', name: 'Agree', tag: 'input', checked: true },
      { ref: 'e3', role: 'checkbox', name: 'Spam', tag: 'input', checked: false },
      { ref: 'e4', role: 'button', name: 'Buy', tag: 'button', disabled: true },
    ];
    const lines = buildOutline(elements).split('\n');
    expect(lines[0]).toBe('[e1] textbox "Search" value="fish"');
    expect(lines[1]).toBe('[e2] checkbox "Agree" (checked)');
    expect(lines[2]).toBe('[e3] checkbox "Spam" (unchecked)');
    expect(lines[3]).toBe('[e4] button "Buy" (disabled)');
  });

  it('truncates very long outlines with a marker instead of growing unbounded', () => {
    const many: DistilledElement[] = Array.from({ length: 1000 }, (_, i) => ({
      ref: `e${i + 1}`,
      role: 'link',
      name: 'x'.repeat(100),
      tag: 'a',
    }));
    const outline = buildOutline(many);
    expect(outline.endsWith('...[truncated]')).toBe(true);
    expect(outline.length).toBeLessThan(16_000);
  });
});

describe('resolveRef', () => {
  it('throws a descriptive error on malformed refs before touching the page', () => {
    const page = {} as Page; // never dereferenced on the error path
    for (const bad of ['', 'x1', 'e', 'e1a', '1', 'E2', 'e-1']) {
      expect(() => resolveRef(page, bad)).toThrow(/Invalid element ref/);
    }
  });

  it('resolves well-formed refs via a data-nf-ref attribute selector', () => {
    const sentinel = { kind: 'locator' } as unknown as Locator;
    let received: string | undefined;
    const page = {
      locator(selector: string): Locator {
        received = selector;
        return sentinel;
      },
    } as unknown as Page;

    expect(resolveRef(page, 'e12')).toBe(sentinel);
    expect(received).toBe('[data-nf-ref="e12"]');
  });
});
