import { describe, expect, test } from "vitest";
import { gitPolicy } from "./git-policy.ts";

const words = (line: string): string[] => line.split(" ").filter((w) => w !== "");

describe("architect Git policy", () => {
  test.each([
    "status",
    "status --short",
    "status --porcelain=v2 -- src",
    "--no-pager log --oneline -10",
    "log --oneline --graph --all",
    "log -n 5 --author=someone -- src/a.ts",
    "log --since 2.weeks --grep fix -p",
    "log --pretty=format:%H HEAD~3..HEAD",
    "log --format=%H -3",
    "show --format=%s HEAD",
    "stash list --format=%gd",
    "branch --format %(refname:short)",
    "tag --list --format %(refname)",
    "diff",
    "diff --cached --stat",
    "diff -U5 HEAD~1 -- src",
    "diff --word-diff=color main...HEAD",
    "show HEAD:src/example.ts",
    "show --stat HEAD",
    "grep -n symbol -- src",
    "grep -e pattern -C 2 HEAD",
    "ls-files -s src",
    "ls-files --others --exclude-standard",
    "ls-tree -r --name-only HEAD",
    "rev-parse --show-toplevel",
    "rev-parse --abbrev-ref HEAD",
    "blame -L 10,20 src/a.ts",
    "blame -L10,20 -- src/a.ts",
    "branch",
    "branch --show-current",
    "branch -a -v",
    "branch --list",
    "branch --list feature/*",
    "branch --contains=HEAD",
    "tag",
    "tag -l v1.*",
    "tag --list --sort=-creatordate",
    "reflog",
    "reflog --all",
    "reflog show HEAD",
    "reflog show -n 5 main",
    "reflog exists main",
    "remote",
    "remote -v",
    "remote get-url origin",
    "remote show",
    "remote show -n origin",
    "stash list",
    "stash show -p stash@{0}",
    "worktree list",
    "worktree list --porcelain",
  ])("allows read-only 'git %s'", (line) => {
    expect(gitPolicy(words(line))).toBeUndefined();
  });

  test.each([
    // Mutating subcommands.
    "add -f .bounded/harness/scripts/bounded",
    "update-index --chmod=+x .bounded/harness/scripts/bounded",
    "checkout-index -f -- .bounded/harness/scripts/bounded",
    "rm --cached .bounded/harness/scripts/bounded",
    "reset --hard",
    "commit -m change",
    "config core.hooksPath scratch/hooks",
    "config --get core.hooksPath",
    "symbolic-ref HEAD refs/heads/x",
    "update-ref refs/heads/main HEAD~1",
    "replace HEAD HEAD~1",
    "submodule update --init",
    "bisect start",
    "notes add -m x",
    "checkout main",
    "__proto__",
    "",
    // Positional words that mutate under an otherwise read-only subcommand.
    "reflog expire --all",
    "reflog expire --expire=now --all",
    "reflog delete HEAD@{1}",
    "reflog drop main",
    "reflog HEAD",
    "reflog --all expire",
    "branch foo",
    "branch foo HEAD~1",
    "branch -- foo",
    "branch -m old new",
    "branch -M new",
    "branch -d foo",
    "branch -D foo",
    "branch -f main HEAD~1",
    "branch -c old new",
    "branch --set-upstream-to=origin/main",
    "branch -u origin/main",
    "branch --edit-description",
    "branch --contains HEAD foo",
    "branch -l foo",
    "tag x",
    "tag -a v1 -m msg",
    "tag -d v1",
    "tag -f v1",
    "tag -v v1",
    "remote add evil https://example.invalid/x.git",
    "remote remove origin",
    "remote rename origin up",
    "remote set-url origin https://example.invalid/x.git",
    "remote prune origin",
    "remote update",
    "remote show origin",
    "stash",
    "stash push",
    "stash drop",
    "stash pop",
    "stash apply",
    "stash clear",
    "stash -- src",
    "stash list extra",
    "worktree add ../x",
    "worktree remove ../x",
    "worktree prune",
    "worktree",
    // Options that write files, run programs or redirect Git.
    "diff --output=src/crm/model.ts",
    "diff --output src/crm/model.ts",
    "log -p --output=x.patch",
    // The log family reads --format/--pretty only stuck on; a separate next
    // word is Git's own option, and `--output` truncates its file.
    "log --format --output=/abs/path",
    "log --pretty --output=/abs/path",
    "show --format --output=/abs/path",
    "reflog --format --output=/abs/path",
    "reflog show --format --output=/abs/path",
    "stash list --format --output=/abs/path",
    "branch --format --output=/abs/path",
    "diff --ext-diff",
    "diff --textconv",
    "show --ext-diff HEAD",
    "log --textconv -p",
    "grep -O sh pattern",
    "grep --open-files-in-pager=sh pattern",
    "-c alias.x=!sh status",
    "-c core.pager=sh log",
    "--exec-path=/tmp/evil status",
    "-C /elsewhere status",
    "--git-dir=/elsewhere/.git log",
    "--work-tree=/tmp status",
    "-p log",
    "--paginate log",
    "blame --contents",
    "log -n",
  ])("refuses 'git %s'", (line) => {
    expect(gitPolicy(words(line))).toBeDefined();
  });

  test("names what was refused", () => {
    expect(gitPolicy(["reflog", "expire", "--all"])).toMatch(/reflog 'expire'/);
    expect(gitPolicy(["branch", "foo"])).toMatch(/branch 'foo'.*--list/);
    expect(gitPolicy(["stash"])).toMatch(/needs a read-only verb/);
  });
});

// Every option the table reads with a separate value, followed by an output
// word. Probed against Git 2.50: none of these write a file today, and the
// blanket refusal keeps any future table entry from making one do so.
describe("no word of an allowed call names Git's file output", () => {
  const forms = [
    ...["log", "show", "reflog", "reflog show", "stash list"].flatMap((sub) =>
      ["--diff-filter", "--stat-width", "-n", "--max-count", "--skip", "--since", "--until", "--after", "--before",
        "--author", "--committer", "--grep", "-S", "-G", "--format", "--pretty", "--date", "-L"].map((opt) => `${sub} ${opt}`)),
    ...["-e", "-A", "-B", "-C", "--context", "--after-context", "--before-context", "--max-depth"].map((opt) => `grep ${opt}`),
    "blame -L", "diff --diff-filter", "stash show --stat-width",
    ...["branch", "tag"].flatMap((sub) => ["--points-at", "--format", "--sort"].map((opt) => `${sub} ${opt}`)),
  ];
  test.each(forms.flatMap((form) => ["--output=/abs/out", "--output", "--output-directory=/x"].map((word) => `${form} ${word}`)))(
    "refuses 'git %s'", (line) => {
      expect(gitPolicy(words(line))).toBeDefined();
    });
});
