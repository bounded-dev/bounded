import type { ShellCommandReader } from "bounded/application";
import { Command, type ProjectPath, type ShellCommandReadingJSON, type ShellCommandWordJSON } from "bounded/domain";
import type { PathKind, ShellWord } from "../../../domain/shell-command.contract.ts";
import { describeShellCommand } from "../../../domain/shell-command.ts";
import { type BashGrammar, type BashSyntaxTree, bashSyntaxTree, loadBashGrammar } from "./bash-syntax-tree.ts";
import { fileSystemPathKind } from "./path-kinds.ts";

/** What a TreeSitterShellCommandReader may be given instead of its defaults: what is at a project's paths (the disk), and how the grammar loads (bash's, once per process). */
export interface TreeSitterShellCommandReaderOptions {
  readonly pathKindOf?: (projectRoot: string, path: ProjectPath) => PathKind | undefined;
  readonly loadGrammar?: () => Promise<BashGrammar>;
}

/** The longest command read, in characters: far past any typed or generated for one tool call; past it, the command is unread. */
const MAX_COMMAND_CHARACTERS = 65_536;
/** The most words (runs of non-blank characters) a command read may have; past it, the command is unread. */
const MAX_COMMAND_WORDS = 10_000;

const message = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));
const wordOf = ({ kind, text }: ShellWord): ShellCommandWordJSON => ({ kind, text });

/**
 * bounded's shell command reader (ADR 2026-020): a command parsed with
 * tree-sitter's bash grammar and translated (domain/shell-command.ts) into
 * the programs it runs, the files it reads, lists and writes, and what only
 * the shell can resolve, as a reading's wire form. A write is a create or a
 * modify by whether its file exists on disk; when that cannot be told, it is
 * both, each marked existenceUnknown. PowerShell and every other shell are
 * read as bash. One reader serves every project: the grammar loads once.
 */
export class TreeSitterShellCommandReader implements ShellCommandReader {
  private syntaxTree: Promise<BashSyntaxTree> | undefined;
  private readonly pathKindOf: (projectRoot: string, path: ProjectPath) => PathKind | undefined;
  private readonly loadGrammar: () => Promise<BashGrammar>;

  constructor(options: TreeSitterShellCommandReaderOptions = {}) {
    this.pathKindOf = options.pathKindOf ?? fileSystemPathKind;
    this.loadGrammar = options.loadGrammar ?? loadBashGrammar;
  }

  /** Loads the grammar; preparing twice is harmless, and reading does not need it first. */
  async prepare(): Promise<void> {
    await this.parser();
  }

  async read(projectRoot: string, command: Command, cwd: ProjectPath | null): Promise<ShellCommandReadingJSON> {
    const tree = await this.parser();
    // Bounded before parsing: a command past either limit is unread, too complex, whatever it says.
    const characters = command.value.length;
    if (characters > MAX_COMMAND_CHARACTERS) return { outcome: "unread", why: `the command is too long to read: ${characters} characters, past bounded's limit of ${MAX_COMMAND_CHARACTERS}`, cause: "too-complex" };
    const words = command.value.split(/\s+/).filter((word) => word !== "").length;
    if (words > MAX_COMMAND_WORDS) return { outcome: "unread", why: `the command is too long to read: ${words} words, past bounded's limit of ${MAX_COMMAND_WORDS}`, cause: "too-complex" };
    const parsed = tree.parse(command);
    if (!parsed.ok) return { outcome: "unread", why: parsed.error, cause: parsed.cause };
    const parseScript = (script: string) => {
      const nested = Command.parse(script);
      return nested.ok ? tree.parse(nested.value) : nested;
    };
    const described = describeShellCommand(parsed.value, { cwd, root: projectRoot, kindOfPath: (path) => this.pathKindOf(projectRoot, path), parseScript });
    // A command that outgrew the work budget is unread, never a reduced reading: a pack that needs the reading refuses it.
    if (described.unreadWhy !== undefined) return { outcome: "unread", why: described.unreadWhy, cause: "too-complex" };
    return {
      outcome: "read",
      programs: described.programs.map((program) => ({ name: wordOf(program.name), arguments: program.arguments.map(wordOf), workingDirectory: program.workingDirectory === null ? null : program.workingDirectory.value })),
      fileEffects: [
        ...described.reads.map((path) => ({ effect: { kind: "read" as const, path: path.value } })),
        ...described.lists.map((root) => ({ effect: { kind: "list" as const, root: root.value } })),
        // Whether a written file exists could not be told: it is given as both a create and a modify, each marked.
        ...described.writes.map(({ path, change, undetermined }) => ({ effect: { kind: "write" as const, path: path.value, change }, ...(undetermined === true ? { existenceUnknown: true } : {}) })),
      ],
      unresolved: described.unresolved.map(({ text, role }) => ({ text, role })),
    };
  }

  /** The parser, its grammar loaded once; a load that fails is tried again next time, and says why. */
  private parser(): Promise<BashSyntaxTree> {
    this.syntaxTree ??= bashSyntaxTree(this.loadGrammar).catch((thrown: unknown) => {
      this.syntaxTree = undefined;
      throw new Error(`bounded's shell parser could not load (${message(thrown)})`);
    });
    return this.syntaxTree;
  }
}
