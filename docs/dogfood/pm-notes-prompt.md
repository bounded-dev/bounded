<!--
The dogfood prompt for the hexagonal monorepo rework (ADRs 2026-056 to
2026-064). It describes the worked example's product — projects and notes,
reached from a browser, a desktop app, AI assistants and a scheduled export —
in product language only. Intake strips the how (ADR 2026-032), so this text
names no framework, runtime, database or file layout: the stack must come
from the composed packs, and the structure from the harness's conventions.

Use it on an arm initialized by `bounded init` with the whole stack
(`scripts/dogfood/reset --init <host> --harnessed docs/dogfood/pm-notes-prompt.md`).
After the run, compare the arm with the worked example:
`BOUNDED_EXAMPLE_PROJECT=<example> node scripts/dogfood/structure-compare.ts <arm>`.
Rendered without this comment; do not edit the body between runs.
-->

We need a small tool for keeping track of our projects and the notes people
write about them.

**Projects.** Anyone can create a project by giving it a name, and anyone can
see the list of all projects. A project's name is required: leading and
trailing spaces don't count, so a name that is empty or only spaces is
refused with the message "Project name is required". The name is kept
without those surrounding spaces. Every project gets its own identity when it
is created, and two projects may share a name. A request to create a project
that has no name at all, or gives it as something other than text, is refused
with "Invalid create project input".

**Notes.** Anyone can create a note for a project by giving the project and
the note's text, and anyone can see the list of all notes, each showing which
project it belongs to and its text. The text is required on the same terms as
a project's name: empty or only spaces is refused with "Note text is
required", and it is kept without surrounding spaces. A note always belongs to
exactly one project that already exists. Every note gets its own identity
when it is created.

Creating a note checks these in order, and the first that fails is the answer:

1. The request gives both the project and the text, each as text; otherwise
   "Invalid create note input".
2. The project reference is a valid project identity; otherwise "Invalid
   project id".
3. The note's text is not empty once trimmed; otherwise "Note text is
   required".
4. The project exists; otherwise "Project not found".

So a malformed project reference together with blank text is answered
"Invalid project id", and blank text for a project that doesn't exist is
answered "Note text is required".

A refused request changes nothing, and whoever made it gets the reason in
exactly the words above rather than a generic error.

**Export.** A scheduled job, run in the cloud on a timer, exports the whole
list of projects to our reporting side. Where exactly the export ends up
isn't decided yet; for now it is enough that each run writes the full list
out where the job runs, so we can see it happen.

**Where people use it.**

- **In a browser:** a web app whose first screen lists the projects by name.
  Through the web app, people can create and list projects and create and
  list notes.
- **On the desktop:** an installable desktop app with the same four actions
  as the web app.
- **From AI assistants:** assistants such as Claude can create a project and
  list the projects, as two tools described to them as "Create a project" and
  "List all projects". Notes are not available to assistants.
- **The export job** above.

Projects and notes must be kept safely, so nothing is lost when an app
restarts, and every one of these places sees the same projects and notes.
