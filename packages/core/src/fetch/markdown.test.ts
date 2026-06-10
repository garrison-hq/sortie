import { describe, expect, it } from 'vitest';
import {
  collectLinks,
  extractArticle,
  htmlToMarkdown,
  markdownToText,
  stripBoilerplate,
} from './markdown.js';

const BASE_URL = 'https://example.com/blog/post';

// Readability needs a few hundred chars of real prose to score an article.
const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do eiusmod. '.repeat(12);

function articleFixture(): string {
  return `<!DOCTYPE html>
<html>
  <head><title>Fixture Article — Example Site</title></head>
  <body>
    <nav><a href="/home">Home</a> <a href="/about">About</a></nav>
    <header>Site-wide promo banner</header>
    <article>
      <h1>Fixture Article</h1>
      <p>${LOREM}</p>
      <p>Read the <a href="/docs/guide">full guide</a> or see
        <img src="/images/figure.png" alt="a figure"> for details.</p>
      <p>${LOREM}</p>
    </article>
    <footer>Copyright junk and sitemap links</footer>
    <script>console.log('tracking');</script>
  </body>
</html>`;
}

describe('extractArticle', () => {
  it('isolates the article, drops nav/footer junk, and absolutizes URLs', () => {
    const article = extractArticle(articleFixture(), BASE_URL);

    expect(article).toBeDefined();
    expect(article?.title).toContain('Fixture Article');
    expect(article?.contentHtml).toContain('Lorem ipsum');
    expect(article?.contentHtml).toContain('https://example.com/docs/guide');
    expect(article?.contentHtml).toContain('https://example.com/images/figure.png');
    expect(article?.contentHtml).not.toContain('promo banner');
    expect(article?.contentHtml).not.toContain('Copyright junk');
    expect(article?.contentHtml).not.toContain('tracking');
  });

  it('returns undefined for pages too small to score (fallback trigger)', () => {
    const html = '<html><head><title>Tiny</title></head><body><p>Hello.</p></body></html>';
    expect(extractArticle(html, BASE_URL)).toBeUndefined();
  });
});

describe('stripBoilerplate', () => {
  it('removes script/style/nav/header/footer/iframe and keeps the content', () => {
    const html = `<html><body>
      <nav>menu items</nav>
      <header>masthead</header>
      <p>The actual content with a <a href="../other">relative link</a>.</p>
      <iframe src="https://ads.example.net/slot"></iframe>
      <footer>legal fine print</footer>
      <script>var x = 1;</script>
      <style>body { color: red; }</style>
    </body></html>`;

    const stripped = stripBoilerplate(html, BASE_URL);

    expect(stripped).toContain('The actual content');
    expect(stripped).toContain('https://example.com/other');
    expect(stripped).not.toContain('menu items');
    expect(stripped).not.toContain('masthead');
    expect(stripped).not.toContain('legal fine print');
    expect(stripped).not.toContain('ads.example.net');
    expect(stripped).not.toContain('var x = 1');
    expect(stripped).not.toContain('color: red');
  });
});

describe('htmlToMarkdown', () => {
  it('uses atx headings and dash bullets', () => {
    const markdown = htmlToMarkdown('<h2>Section</h2><ul><li>one</li><li>two</li></ul>');
    expect(markdown).toContain('## Section');
    expect(markdown).toMatch(/^- {3}one$/m);
    expect(markdown).toMatch(/^- {3}two$/m);
  });

  it('renders fenced code blocks with the language tag', () => {
    const markdown = htmlToMarkdown(
      '<pre><code class="language-js">const answer = 42;</code></pre>',
    );
    expect(markdown).toContain('```js');
    expect(markdown).toContain('const answer = 42;');
    expect(markdown.trimEnd().endsWith('```')).toBe(true);
  });

  it('renders GFM tables', () => {
    const markdown = htmlToMarkdown(
      '<table><thead><tr><th>Name</th><th>Price</th></tr></thead>' +
        '<tbody><tr><td>Book</td><td>£12</td></tr></tbody></table>',
    );
    expect(markdown).toContain('| Name | Price |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| Book | £12 |');
  });

  it('drops script and style contents', () => {
    const markdown = htmlToMarkdown('<p>keep</p><script>drop()</script><style>.x{}</style>');
    expect(markdown).toContain('keep');
    expect(markdown).not.toContain('drop()');
    expect(markdown).not.toContain('.x{}');
  });
});

describe('collectLinks', () => {
  it('resolves relative hrefs against the base URL', () => {
    const links = collectLinks(
      '<a href="/abs/path">Absolute path</a> <a href="sibling">Sibling</a>',
      BASE_URL,
    );
    expect(links).toEqual([
      { text: 'Absolute path', url: 'https://example.com/abs/path' },
      { text: 'Sibling', url: 'https://example.com/blog/sibling' },
    ]);
  });

  it('skips non-http(s) schemes and dedupes by URL', () => {
    const links = collectLinks(
      '<a href="mailto:a@b.c">Mail</a><a href="javascript:void(0)">JS</a>' +
        '<a href="https://example.com/x">First</a><a href="/x">Duplicate</a>',
      BASE_URL,
    );
    expect(links).toEqual([{ text: 'First', url: 'https://example.com/x' }]);
  });
});

describe('markdownToText', () => {
  it('strips markdown syntax but keeps the content', () => {
    const text = markdownToText(
      '# Title\n\nSome **bold** and _italic_ text with a [link](https://example.com) ' +
        'and `inline code`.\n\n```js\nconst x = 1;\n```\n\n> quoted line\n\n---\n',
    );
    expect(text).toContain('Title');
    expect(text).toContain('Some bold and italic text with a link and inline code.');
    expect(text).toContain('const x = 1;');
    expect(text).toContain('quoted line');
    expect(text).not.toContain('#');
    expect(text).not.toContain('**');
    expect(text).not.toContain('```');
    expect(text).not.toContain('https://example.com');
  });
});
