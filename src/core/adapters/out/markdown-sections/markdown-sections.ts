// Markdown split into sections by marked's lexer (ADR 2026-026), the package's own
// devDependency: a heading or code span inside a fenced block is the block's text, never
// structure. Each heading of level one or two starts a section; deeper headings stay in theirs.
import type { MarkdownDocument, MarkdownSections } from "bounded/application";
import type { ReadmeSection, ReadmeText, Result } from "bounded/domain";
import { loadPackageLibrary } from "../package-library.ts";

/** A token of marked's lexer, as far as sections need it. */
interface Token {
  readonly type: string;
  readonly raw: string;
  readonly text?: string;
  readonly depth?: number;
}
type Lexer = (markdown: string) => unknown;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const isToken = (value: unknown): value is Token => isRecord(value) && typeof value.type === "string" && typeof value.raw === "string";

/** Every token in `value`, at any depth (inline tokens, list items, table cells), in document order. */
function tokensIn(value: unknown, found: Token[] = []): Token[] {
  if (Array.isArray(value)) for (const item of value) tokensIn(item, found);
  else if (isRecord(value)) {
    if (isToken(value)) found.push(value);
    for (const [key, child] of Object.entries(value)) if (key !== "raw" && key !== "text" && typeof child === "object") tokensIn(child, found);
  }
  return found;
}

/** A stretch of the document: its Markdown as written, its inline code spans and its code blocks' text. */
function textOf(tokens: readonly Token[]): ReadmeText {
  const all = tokensIn(tokens);
  return {
    markdown: tokens.map((token) => token.raw).join("").trim(),
    codeSpans: all.filter((token) => token.type === "codespan").map((token) => token.text ?? ""),
    codeBlocks: all.filter((token) => token.type === "code").map((token) => token.text ?? ""),
  };
}

const isSectionHeading = (token: Token): boolean => token.type === "heading" && (token.depth === 1 || token.depth === 2);

export class MarkedMarkdownSections implements MarkdownSections {
  async read(packageDir: string, markdown: string): Promise<Result<MarkdownDocument>> {
    const loaded = await loadPackageLibrary(packageDir, "marked");
    if (!loaded.ok) return loaded;
    const library = loaded.value;
    const lexer: unknown = isRecord(library) ? (library.lexer ?? (isRecord(library.marked) ? library.marked.lexer : undefined)) : undefined;
    if (typeof lexer !== "function") return { ok: false, error: "marked, as the package resolves it, has no lexer: reinstall it as a devDependency of the package to build its catalogue" };
    let lexed: unknown;
    try {
      lexed = (lexer as Lexer)(markdown);
    } catch (thrown) {
      return { ok: false, error: `the Markdown cannot be read: ${thrown instanceof Error ? thrown.message : String(thrown)}` };
    }
    const tokens = Array.isArray(lexed) ? lexed.filter(isToken) : [];
    const firstContent = tokens.findIndex((token) => token.type !== "space");
    const opening = tokens[firstContent];
    const title = opening !== undefined && opening.type === "heading" && opening.depth === 1 ? (opening.text ?? "") : null;
    const rest = title === null ? tokens : tokens.slice(firstContent + 1);
    const firstSection = rest.findIndex(isSectionHeading);
    const introduction = firstSection < 0 ? rest : rest.slice(0, firstSection);
    const sections: (ReadmeSection & { readonly level: number })[] = [];
    let heading: Token | undefined;
    let body: Token[] = [];
    const close = (): void => {
      if (heading !== undefined) sections.push({ heading: heading.text ?? "", level: heading.depth ?? 2, ...textOf(body) });
    };
    for (const token of firstSection < 0 ? [] : rest.slice(firstSection)) {
      if (isSectionHeading(token)) {
        close();
        heading = token;
        body = [];
      } else body.push(token);
    }
    close();
    return { ok: true, value: { title, introduction: textOf(introduction), sections } };
  }
}
