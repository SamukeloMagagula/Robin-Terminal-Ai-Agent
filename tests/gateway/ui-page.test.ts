import { describe, it, expect } from 'vitest';
import { controlUiPage } from '../../src/gateway/ui-page';
import { PROTOCOL_VERSION } from '../../src/gateway/protocol';

const page = controlUiPage(PROTOCOL_VERSION);

/**
 * Runs a function out of the page as the browser would receive it.
 *
 * The page is a TypeScript template literal, so every backslash in it is
 * consumed once before it is served. That silently broke every regex in the
 * renderer — one threw and the rest simply stopped matching — and nothing
 * caught it, because no test had ever executed this code. These do.
 */
function fromPage(name: string, upTo: string): (input: string) => string {
  const prelude = page.slice(page.indexOf('const BT ='), page.indexOf(`function ${name}(`));
  const body = page.slice(page.indexOf(`function ${name}(`), page.indexOf(upTo));
  return new Function(`${prelude}${body}; return ${name};`)() as (input: string) => string;
}

const inline = fromPage('inline', 'function renderMarkdown(');
const renderMarkdown = fromPage('renderMarkdown', '  const message =');

describe('the page as served', () => {
  it('substitutes the protocol version', () => {
    expect(page).toContain(`protocol: ${PROTOCOL_VERSION}`);
    expect(page).not.toContain('__PROTOCOL__');
  });

  // A backslash eaten by the template literal turns /\d+/ into /d+/, which is
  // a valid regex that matches the wrong thing — no error, just wrong output.
  it('keeps the escapes its regexes need', () => {
    expect(page).toContain(String.raw`/^(#{1,6})\s+(.*)$/`);
    expect(page).toContain(String.raw`\[([^\]]+)\]`);
  });
});

describe('the browser renderer', () => {
  it.each([
    ['**bold**', '<strong>bold</strong>'],
    ['*italic*', '<em>italic</em>'],
    ['~~gone~~', '<del>gone</del>'],
    ['`code`', '<code>code</code>'],
  ])('renders %s', (input, expected) => {
    expect(inline(input)).toContain(expected);
  });

  it('leaves snake_case and arithmetic alone', () => {
    expect(inline('read_file and 2 * 3 * 4')).toBe('read_file and 2 * 3 * 4');
  });

  it('does not style inside a code span', () => {
    expect(inline('`a **b** c`')).toBe('<code>a **b** c</code>');
  });

  it('escapes html so a reply cannot inject markup', () => {
    expect(inline('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });

  // The page holds the gateway token, and model output reaches innerHTML.
  it('refuses a javascript: link, keeping it as text', () => {
    const rendered = inline('[click](javascript:alert(1))');
    expect(rendered).not.toContain('<a');
    expect(rendered).toContain('click');
  });

  it('makes an http link an anchor that cannot reach back', () => {
    const rendered = inline('[docs](https://example.com)');
    expect(rendered).toContain('href="https://example.com"');
    expect(rendered).toContain('rel="noreferrer noopener"');
  });

  it('renders a bullet list as a list', () => {
    const html = renderMarkdown('- one\n- two');
    expect(html).toContain('<ul>');
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it('renders a numbered list as an ordered one', () => {
    expect(renderMarkdown('1. one\n2. two')).toContain('<ol>');
  });

  it('renders a fenced block without styling what is inside it', () => {
    const html = renderMarkdown('```js\nconst a = **not bold**;\n```');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('**not bold**');
    expect(html).not.toContain('<strong>');
  });

  it('closes an unterminated fence rather than losing the answer', () => {
    expect(renderMarkdown('```\nstill here')).toContain('still here');
  });

  it('renders a heading and a quote', () => {
    expect(renderMarkdown('# Title')).toContain('<h3>Title</h3>');
    expect(renderMarkdown('> quoted')).toContain('<blockquote>quoted</blockquote>');
  });
});
