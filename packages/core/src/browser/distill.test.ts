import { afterEach, describe, expect, it } from 'vitest';
import type { Page, Locator } from 'playwright';
import type { DistilledElement } from '../contracts.js';
import { buildOutline, distillPage, resolveRef, PASSWORD_MASK } from './distill.js';

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

// ---------------------------------------------------------------------------
// distillPage password redaction — runs the in-page walker against a fake DOM
// (the walker only uses structural types, so no browser is needed).
// ---------------------------------------------------------------------------

interface FakeElementInit {
  tag: string;
  attrs?: Record<string, string>;
  value?: string;
  text?: string;
}

interface FakeElement {
  tagName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getBoundingClientRect(): { width: number; height: number };
  matches(selector: string): boolean;
  shadowRoot: null;
  offsetParent: unknown;
  innerText: string;
  value?: string;
}

function makeFakeElement(init: FakeElementInit): FakeElement {
  const attrs = new Map(Object.entries(init.attrs ?? {}));
  const el: FakeElement = {
    tagName: init.tag.toUpperCase(),
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => {
      attrs.set(name, value);
    },
    removeAttribute: (name) => {
      attrs.delete(name);
    },
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    // Every fake is a candidate, mirroring the pre-shadow-DOM fixture shape.
    matches: () => true,
    shadowRoot: null,
    offsetParent: {},
    innerText: init.text ?? '',
  };
  if (init.value !== undefined) el.value = init.value;
  return el;
}

/**
 * Install a fake `document`/`getComputedStyle` on globalThis and return a
 * fake Page whose evaluate() runs the walker locally against them.
 */
function installFakeDom(elements: FakeElement[], bodyText = ''): Page {
  const g = globalThis as Record<string, unknown>;
  g['document'] = {
    querySelectorAll: (selector: string) =>
      selector === '[data-nf-ref]'
        ? elements.filter((el) => el.getAttribute('data-nf-ref') !== null)
        : elements,
    body: { innerText: bodyText },
  };
  g['getComputedStyle'] = () => ({ visibility: 'visible', display: 'block', position: 'static' });

  return {
    evaluate: (fn: (arg: string) => unknown, arg: string) => Promise.resolve(fn(arg)),
    url: () => 'https://example.com/login',
    title: () => Promise.resolve('Login'),
  } as unknown as Page;
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g['document'];
  delete g['getComputedStyle'];
});

describe('distillPage — password redaction', () => {
  const RAW_PASSWORD = 'hunter2-very-secret';

  it('masks non-empty password values everywhere and keeps other values intact', async () => {
    const page = installFakeDom([
      makeFakeElement({
        tag: 'input',
        attrs: { type: 'text', placeholder: 'Username' },
        value: 'admin',
      }),
      makeFakeElement({
        tag: 'input',
        attrs: { type: 'password', placeholder: 'Password' },
        value: RAW_PASSWORD,
      }),
    ]);

    const snapshot = await distillPage(page);

    const [username, password] = snapshot.elements;
    expect(username?.value).toBe('admin');
    expect(password?.value).toBe(PASSWORD_MASK);

    // The raw secret appears nowhere in the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain(RAW_PASSWORD);
    expect(snapshot.outline).toContain(`value="${PASSWORD_MASK}"`);
    expect(snapshot.outline).toContain('value="admin"');
  });

  it('reports empty password fields as empty, not masked', async () => {
    const page = installFakeDom([
      makeFakeElement({ tag: 'input', attrs: { type: 'password' }, value: '' }),
    ]);

    const snapshot = await distillPage(page);

    expect(snapshot.elements[0]?.value).toBe('');
    expect(snapshot.outline).not.toContain(PASSWORD_MASK);
  });

  it('never derives an element name from a password value', async () => {
    // Unlabeled password input: no aria-label/placeholder/text, only a value.
    const page = installFakeDom([
      makeFakeElement({ tag: 'input', attrs: { type: 'password' }, value: RAW_PASSWORD }),
      // Control: a text input in the same situation does use its value.
      makeFakeElement({ tag: 'input', attrs: { type: 'text' }, value: 'visible-value' }),
    ]);

    const snapshot = await distillPage(page);

    expect(snapshot.elements[0]?.name).toBe('');
    expect(snapshot.elements[1]?.name).toBe('visible-value');
    expect(JSON.stringify(snapshot)).not.toContain(RAW_PASSWORD);
  });
});
