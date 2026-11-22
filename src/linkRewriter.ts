/**
 * Rewrites links aimed at this extension so they open in the editor it runs in:
 * - the scheme becomes the running editor's (`vscode://` in VS Code, `cursor://` in Cursor);
 * - a legacy authority (a former extension id, e.g. `example.old-name`)
 *   becomes the current one, so links in older review files keep working.
 * Applied to the markdown preview and the markdown source editor. Pure, no VS Code imports.
 */

const LINK_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/i;
const NEVER_REWRITE = new Set(['http', 'https', 'file', 'mailto', 'data', 'javascript']);

export function rewriteHref(href: string, authority: string, scheme: string, legacy: readonly string[] = []): string {
  const m = LINK_RE.exec(href);
  if (!m) return href;
  const [, linkScheme, linkAuthority, rest] = m;
  if (NEVER_REWRITE.has(linkScheme.toLowerCase())) return href;
  const lower = linkAuthority.toLowerCase();
  const isCurrent = lower === authority.toLowerCase();
  const isLegacy = legacy.some((a) => a.toLowerCase() === lower);
  if (!isCurrent && !isLegacy) return href;
  if (isCurrent && linkScheme === scheme) return href;
  return `${scheme}://${isLegacy ? authority : linkAuthority}${rest}`;
}

/** Minimal markdown-it shapes, to avoid a dependency on its types. */
interface Token {
  type: string;
  children: Token[] | null;
  attrGet(name: string): string | null;
  attrSet(name: string, value: string): void;
}
interface MarkdownIt {
  core: { ruler: { push(name: string, rule: (state: { tokens: Token[] }) => void): void } };
}

export function markdownItSchemePlugin<T>(md: T, authority: string, scheme: string, legacy: readonly string[] = []): T {
  (md as unknown as MarkdownIt).core.ruler.push('deep_diff_links_scheme', (state) => {
    const visit = (tokens: Token[]) => {
      for (const token of tokens) {
        if (token.type === 'link_open') {
          const href = token.attrGet('href');
          if (href) token.attrSet('href', rewriteHref(href, authority, scheme, legacy));
        }
        if (token.children) visit(token.children);
      }
    };
    visit(state.tokens);
  });
  return md;
}

/** A link to rewrite in plain text, with its offsets. */
export interface TextLink {
  start: number;
  end: number;
  target: string;
}

const URL_CHARS = String.raw`[^\s()<>\[\]"'\`]*`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds links to this extension that the editor can't open as written (another editor's
 * scheme, e.g. `vscode://` while running in Cursor, or a legacy authority) and returns
 * their rewritten targets. Links that already open as written are skipped.
 */
export function findForeignLinks(text: string, authority: string, scheme: string, legacy: readonly string[] = []): TextLink[] {
  const authorities = [authority, ...legacy].map(escapeRe).join('|');
  const re = new RegExp(String.raw`\b([a-z][a-z0-9+.-]*)://(?:${authorities})(?=[/?#])${URL_CHARS}`, 'gi');
  const links: TextLink[] = [];
  for (const m of text.matchAll(re)) {
    const href = m[0];
    const target = rewriteHref(href, authority, scheme, legacy);
    if (target !== href) links.push({ start: m.index!, end: m.index! + href.length, target });
  }
  return links;
}
