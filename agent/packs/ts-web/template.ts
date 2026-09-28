// The ts-web reference layout, as text (TN-26-006 B1).
//
// WHY THESE ARE STRINGS AND NOT FILES. The ts-service pack's shipped artifact —
// `packs/ts-service/api/service-runtime.ts` — is a real file, copied verbatim, and it
// typechecks inside the harness because it imports nothing but `@trpc/server`.
// A frontend skeleton cannot be that: `main.tsx` imports an `App` the target's
// own contract has not declared yet, `client.tsx` imports the router type out of
// the target's own service contract, and `app.css` is not TypeScript at all.
// Files that cannot resolve inside the harness cannot typecheck inside it
// either, so storing them as files would buy nothing and cost a tsconfig full
// of exclusions.
//
// The verification happens where it is actually available instead: the
// generator's suite emits the whole layout into a temp project, symlinks the
// harness's `node_modules`, writes the tsconfig a web target uses, and runs the
// real `tsc` over it — the red gate's shadow-project trick, applied to a
// generator. The pinned web stack in the harness's package.json is what makes
// that possible, and it is the same pin list `contrib.json` records for deliver.
//
// EVERY EXPORT HERE IS THE FILE'S BODY WITHOUT ITS MARKER. `markerFor` in
// new-web-app.ts prepends the marker in the comment syntax the extension
// demands, so the marker sentence has exactly one source.

/**
 * The CSS-first Tailwind v4 entry: STRUCTURE only.
 *
 * Generated, marker-carrying, pack-owned, restored on every sync — and it holds
 * no colour of its own. Identity lives one import away in `theme.css`, which
 * this file pulls in and which the PROJECT owns outright (TN-26-006, "Styling:
 * anatomy enforced, identity free").
 *
 * The split is the whole point. Before it, restyling meant editing a generated
 * file, which the generator would then restore — so "the tokens are the
 * restyling surface" was true in prose and false on disk. Now: structure
 * generated, identity owned, and a fresh look is a fresh `theme.css` and
 * nothing else.
 *
 * `@import "./theme.css"` sits AFTER `@import "tailwindcss"` because Tailwind
 * v4 inlines imports itself and builds its utilities from whatever `@theme`
 * blocks the bundle contains; the theme has to be in the bundle by then.
 */
export const APP_CSS = `@import "tailwindcss";
@import "./theme.css";

html,
body,
#root {
  height: 100%;
}

body {
  background-color: var(--color-background);
  color: var(--color-foreground);
}
`;

/**
 * `src/ui/theme.css` — the ONE project-owned style file.
 *
 * Emitted as a STARTER, only when absent, never marker'd and never
 * overwritten: the generator writes it once and then treats it as somebody
 * else's file forever, which is precisely what makes it safe to edit. Everything
 * else the generator touches it restores.
 *
 * `@theme` is Tailwind v4's CSS-first configuration — these custom properties
 * BECOME utilities (`--color-primary` gives `bg-primary`, `text-primary`), so
 * the kit names semantic colours and a project repaints the whole app from
 * here. No `tailwind.config.js` exists in v4 and none should be added.
 *
 * Two fences keep the freedom safe, and both are mechanical: the
 * `tokens-only-styling` lint means every colour on screen came through one of
 * these names, and the theme gate at delivery refuses a theme that is missing a
 * required token or whose declared foreground/background pairs are unreadable
 * (contrib.json's `requiredThemeTokens` and `contrastPairs`). Any look;
 * never an unreadable or incomplete one.
 */
export const THEME_CSS = `/* THIS FILE IS YOURS. It is the project's visual identity — colours, radii,
   fonts, density — and the generator will never overwrite it: it is written
   once, when absent, and left alone from then on. Edit it freely.

   A fresh look for this project is a fresh version of THIS FILE and nothing
   else. Every other style surface is pack-owned and generated: the component
   kit under src/ui/shared/ui/ and the structure in app.css are restored on
   every generator run, and components may style ONLY through the token names
   below (the tokens-only-styling lint enforces it), so a token you change here
   changes every screen that uses it.

   Two rules the delivery gate checks, so that "any look" never becomes an
   unreadable one:

     1. every token named here must stay defined — the kit styles through them,
        and an undefined token is an invisible element, not an error;
     2. each foreground/background pair must reach WCAG AA contrast (4.5:1 for
        normal text). The gate prints the pair and the ratio it measured.

   Adding tokens of your own is free. A component VARIANT the tokens cannot
   express is a pack change through the change cycle, not a local edit. */

@theme {
  --color-background: oklch(1 0 0);
  --color-foreground: oklch(0.21 0.02 264);
  --color-muted: oklch(0.97 0.01 264);
  --color-muted-foreground: oklch(0.52 0.02 264);
  --color-primary: oklch(0.55 0.18 264);
  --color-primary-foreground: oklch(0.99 0 0);
  --color-destructive: oklch(0.58 0.22 27);
  --color-destructive-foreground: oklch(0.99 0 0);
  --color-border: oklch(0.92 0.01 264);
  --color-ring: oklch(0.55 0.18 264);

  /* The TONES (TN-26-006, "Styling: anatomy enforced, identity free"). A tone
     is a READING of a value — good, watch it, act now, nothing to say — and
     never a domain word: the kit has no idea what a heating band is, and
     mapping a band to a tone happens in entities/ or features/. Four is
     deliberate: a fifth invites "which orange did we mean?" in review. */
  --color-positive: oklch(0.52 0.13 155);
  --color-positive-foreground: oklch(0.99 0 0);
  --color-caution: oklch(0.54 0.14 75);
  --color-caution-foreground: oklch(0.99 0 0);
  --color-critical: oklch(0.51 0.2 27);
  --color-critical-foreground: oklch(0.99 0 0);
  --color-neutral: oklch(0.54 0.02 264);
  --color-neutral-foreground: oklch(0.99 0 0);

  --radius-card: 0.75rem;
}

/* Dark mode overrides only what changes. Every token left out keeps its value
   above — including the four tones, whose foreground/background relationship
   is the same in both schemes. The gate checks this variant too: it overlays
   this block on the one above and re-measures every declared pair. */
@media (prefers-color-scheme: dark) {
  @theme {
    --color-background: oklch(0.21 0.02 264);
    --color-foreground: oklch(0.98 0 0);
    --color-muted: oklch(0.27 0.02 264);
    --color-muted-foreground: oklch(0.71 0.02 264);
    --color-border: oklch(0.32 0.02 264);
  }
}
`;

/** The Vite entry document. `/src/ui/main.tsx` is an absolute, project-rooted
 *  specifier because Vite serves from the project root, not from `index.html`'s
 *  directory. */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/ui/main.tsx"></script>
  </body>
</html>
`;

/**
 * Vite's config: React, Tailwind v4's own plugin, and the `/trpc` proxy.
 *
 * THE PROXY IS A PLACEHOLDER and says so in the file. The dev server and the
 * service's HTTP entry are two processes, and making `npm run dev` start both —
 * and agree on a port — is Phase C. Until then the proxy points at the default
 * `serveStandalone` port, which is right often enough to be useful and wrong
 * loudly enough to be noticed.
 */
export const VITE_CONFIG = `import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // PLACEHOLDER (TN-26-006 Phase C wires this for real). The service's HTTP
      // entry is \`serveStandalone\` from the generated service-runtime; point
      // this at wherever it listens. Until \`npm run dev\` starts both processes,
      // run the service yourself in another terminal.
      "/trpc": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
`;

/**
 * The browser entry.
 *
 * It mounts `<App />` from `./app.js`, and the generator does NOT emit
 * `src/ui/app.tsx`: that file is the architect's to declare as
 * `src/ui/app.contract.ts`, after which `design_gate`'s scaffold step writes a
 * throwing `.tsx` skeleton for it (TN-26-006 A1) and the builder implements it.
 * A generated placeholder there would be a file the scaffolder overwrites and
 * the builder then un-marks, so the next sync would see hand-written work at a
 * pack-owned path and block — the layout would fight the pipeline once per run.
 *
 * `./app.js` with a `.js` extension is the harness's NodeNext specifier style,
 * which Vite resolves to `app.tsx` natively. One spelling, both toolchains.
 */
export function mainTsx(options: { readonly wrapInProvider: boolean }): string {
  const providerImport = options.wrapInProvider
    ? `import { TrpcProvider } from "./shared/api/client.js";\n`
    : "";
  const tree = options.wrapInProvider
    ? `    <TrpcProvider>\n      <App />\n    </TrpcProvider>\n`
    : `    <App />\n`;
  const note = options.wrapInProvider
    ? ""
    : `// No service contract in this tree yet, so nothing wraps the app but StrictMode.\n` +
      `// The moment a *.contract.ts re-exports ServiceRouter, re-run the generator:\n` +
      `// it emits shared/api/client.tsx and wraps the tree in the provider here.\n`;
  return `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
${providerImport}import "./app.css";

${note}const container = document.getElementById("root");
if (container === null) {
  // index.html is generated and carries the mount point; a missing #root means
  // something replaced it, and a silent no-render is the worst possible answer.
  throw new Error("index.html has no <div id=\\"root\\"> — the app has nowhere to mount");
}

createRoot(container).render(
  <StrictMode>
${tree}  </StrictMode>,
);
`;
}

/**
 * The ONE door to the network (TN-26-006).
 *
 * `client-one-door` (B2) refuses a runtime `@trpc/client` or `@tanstack/*` import
 * anywhere but under `src/ui/shared/api/`, for the same reason
 * `raw-framework-entry` gives the service runtime one door: a second transport
 * is a second place the URL, the batching, the headers and the error handling
 * can be got wrong, and they will be got wrong differently.
 *
 * It is a `.tsx`, not the `.ts` the plan named, because it exports a React
 * component and JSX does not parse in a `.ts` file — the same fact that gave
 * the scaffolder a `.tsx` mode in TN-26-006 A1. Splitting the provider into a
 * second file would have kept the extension and lost the one door.
 *
 * `routerSpecifier` points at the service's IMPLEMENTATION module, never at its
 * `*.contract.ts`: a contract's ambient declarations are a second identity for
 * everything they declare (ADR 2026-023), and the implementation module
 * re-exports every type its contract declares.
 */
export function clientTsx(routerSpecifier: string): string {
  return `import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, type TRPCClient } from "@trpc/client";
import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import type { ServiceRouter } from "${routerSpecifier}";

/** The typed client. Every procedure the service declares is reachable here,
 *  with its real input and output types — that is what the router type is for,
 *  and why a service contract must re-export it (router-type-reexported). */
export type ServiceClient = TRPCClient<ServiceRouter>;

/** \`/trpc\` is a same-origin path, proxied to the service by vite.config.ts in
 *  development and by whatever serves the built assets in production. The app
 *  never learns the service's real host. */
export const serviceClient: ServiceClient = createTRPCClient<ServiceRouter>({
  links: [httpBatchLink({ url: "/trpc" })],
});

/** One QueryClient for the whole app: the cache IS the shared read model, and
 *  a second one would silently split it in half. */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

const ServiceClientContext = createContext<ServiceClient | undefined>(undefined);

/**
 * The client, from inside a component.
 *
 * Reading it from context rather than importing \`serviceClient\` directly is
 * what makes a component testable: a test renders it under a provider holding a
 * fake, and nothing in the component knows the difference.
 */
export function useServiceClient(): ServiceClient {
  const client = useContext(ServiceClientContext);
  if (client === undefined) {
    throw new Error("useServiceClient outside <TrpcProvider> — mount the provider at the app root");
  }
  return client;
}

export interface TrpcProviderProps {
  readonly children: ReactNode;
  /** A stand-in client, for tests. Production passes nothing. */
  readonly client?: ServiceClient;
}

export function TrpcProvider(props: TrpcProviderProps): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <ServiceClientContext.Provider value={props.client ?? serviceClient}>
        {props.children}
      </ServiceClientContext.Provider>
    </QueryClientProvider>
  );
}
`;
}

// --- The component kit (TN-26-006 B3) ---------------------------------------
//
// A minimal shadcn-style set: button, card, input, label — joined below by the
// four LAYOUT primitives r24 proved were missing (page-shell, badge, stat,
// data-list). Faithful in SPIRIT —
// copy-in components you own, styled entirely with Tailwind utilities over
// semantic tokens, composed rather than configured — and deliberately not a
// transcription: these are pack-owned, marker-carrying, and never hand-edited,
// so restyling happens through the `@theme` block in app.css and nowhere else
// (ratified at the 2026-09-14 grill).
//
// DEPENDENCIES CHOSEN, AND WHY:
//
//   clsx + tailwind-merge — KEPT, as `cn()`. Not convenience: `twMerge` is what
//     makes a caller's `className="bg-destructive"` actually beat the
//     component's own `bg-primary`, because Tailwind classes have no
//     specificity story of their own and the last one in the string wins only
//     if something de-duplicates the conflict. Without it, "pass a className to
//     override" silently does nothing — the single most confusing failure mode
//     a component kit can have. Roughly 3KB for the pair.
//
//   class-variance-authority — DROPPED. It is the idiomatic shadcn choice, and
//     for four components it buys a dependency, a DSL and an inference story to
//     replace two `Record<Variant, string>` lookups that any reader can follow
//     at a glance. The brief's own instruction was to keep dependencies minimal
//     and take cva only if genuinely needed; with one component having variants,
//     it is not. Revisit when the kit grows compound variants, which is the
//     thing a record cannot express.
//
//   @radix-ui/* — DROPPED for this set. Real shadcn reaches for Radix the
//     moment a component needs focus management or a portal (dialog, popover,
//     select). None of these four do: button, card, input and label are all
//     native elements with classes on them, and a headless-primitives
//     dependency that nothing yet needs is a dependency a project inherits
//     forever. The day the reference set grows a dialog, Radix is the answer
//     and it comes in pinned, like everything else.

/** `cn` — the class merger every component uses. */
export const CN_TS = `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Join class names, with later Tailwind utilities beating earlier conflicting
 * ones.
 *
 * The merge is the point. \`clsx\` alone would produce "bg-primary
 * bg-destructive" and leave the winner to CSS source order, which for two
 * utilities of equal specificity is whichever Tailwind emitted first — not the
 * one the caller passed. \`twMerge\` understands that those two are the same
 * property and keeps the last, so "pass a className to override" is true.
 */
export function cn(...classes: ClassValue[]): string {
  return twMerge(clsx(classes));
}
`;

/** Button — the one component with variants, and the reason \`cn\` exists. */
export const BUTTON_TSX = `import type { ComponentProps, ReactElement } from "react";
import { cn } from "../lib/cn.js";

export type ButtonTone = "primary" | "secondary" | "destructive" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

// Plain lookups rather than a variants DSL: two records a reader can follow at
// a glance, and one fewer dependency in every project that installs this kit.
const TONE: Record<ButtonTone, string> = {
  primary: "bg-primary text-primary-foreground hover:opacity-90",
  secondary: "bg-muted text-foreground hover:bg-muted/80",
  destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
  ghost: "bg-transparent text-foreground hover:bg-muted",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "disabled:pointer-events-none disabled:opacity-50";

export interface ButtonProps extends ComponentProps<"button"> {
  readonly tone?: ButtonTone;
  readonly size?: ButtonSize;
}

/**
 * A button.
 *
 * \`type\` defaults to "button" on purpose: the HTML default is "submit", so a
 * button placed in a form to open a dialog submits the form instead, and the
 * bug reads as "the form submits twice".
 */
export function Button({ tone = "primary", size = "md", className, type = "button", ...rest }: ButtonProps): ReactElement {
  return <button type={type} className={cn(BASE, TONE[tone], SIZE[size], className)} {...rest} />;
}
`;

/** Card — composition, not configuration: six small parts, no props to learn. */
export const CARD_TSX = `import type { ComponentProps, ReactElement } from "react";
import { cn } from "../lib/cn.js";

export function Card({ className, ...rest }: ComponentProps<"div">): ReactElement {
  return <div className={cn("rounded-card border border-border bg-background shadow-sm", className)} {...rest} />;
}

export function CardHeader({ className, ...rest }: ComponentProps<"div">): ReactElement {
  return <div className={cn("flex flex-col gap-1.5 p-6 pb-3", className)} {...rest} />;
}

/** A heading element, so the card announces itself to a screen reader — and so
 *  a blind UI test can find it by role and name (TN-26-006). */
export function CardTitle({ className, ...rest }: ComponentProps<"h3">): ReactElement {
  return <h3 className={cn("text-lg font-semibold leading-none", className)} {...rest} />;
}

export function CardDescription({ className, ...rest }: ComponentProps<"p">): ReactElement {
  return <p className={cn("text-sm text-muted-foreground", className)} {...rest} />;
}

export function CardContent({ className, ...rest }: ComponentProps<"div">): ReactElement {
  return <div className={cn("p-6 pt-0", className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: ComponentProps<"div">): ReactElement {
  return <div className={cn("flex items-center gap-2 p-6 pt-0", className)} {...rest} />;
}
`;

/** Input — a native input with classes, nothing more. */
export const INPUT_TSX = `import type { ComponentProps, ReactElement } from "react";
import { cn } from "../lib/cn.js";

const BASE =
  "flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm " +
  "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className, ...rest }: ComponentProps<"input">): ReactElement {
  return <input className={cn(BASE, className)} {...rest} />;
}
`;

/** Label — a real \`<label>\`, which is what makes \`getByLabelText\` work. */
export const LABEL_TSX = `import type { ComponentProps, ReactElement } from "react";
import { cn } from "../lib/cn.js";

/**
 * A form label.
 *
 * Always give it \`htmlFor\` matching the input's \`id\`. That association is not
 * decoration: it is what lets a click on the text focus the field, what a
 * screen reader announces, and what a test means when it asks for the field
 * "Meter reading" — the blind UI testing this reference set is built for
 * (TN-26-006) keys on exactly that.
 */
export function Label({ className, ...rest }: ComponentProps<"label">): ReactElement {
  return <label className={cn("text-sm font-medium leading-none", className)} {...rest} />;
}
`;

// --- The layout primitives (TN-26-006, "Styling: anatomy enforced, identity
// free") -----------------------------------------------------------------------
//
// WHY THESE FOUR EXIST. Dogfood r24 delivered a behaviourally perfect,
// visually bare screen: 77 green tests over a page that was a stack of
// unstyled `<p>` elements. The builder was not lazy and not blind to the kit —
// it wrote ZERO className, because nothing in the kit it composed produced a
// page, a heading row, a metric or a list. Button/Card/Input/Label are the
// pieces INSIDE a screen; a screen is what the run had to invent, and inventing
// was exactly what the reference set exists to stop.
//
// So the fix is structural rather than instructional: make the styled path the
// DEFAULT path. A builder that composes PageShell → DataList → Card → Stat →
// Badge gets rhythm, measure, hierarchy and tone for free, and writes no
// className at all — which is also what makes the `tokens-only-styling` rule a
// small ask rather than a straitjacket.
//
// EVERYTHING HERE IS GENERIC — the kit is `shared`, and Law 1 (downward-only
// imports) means it can never learn a domain. That is why the Badge's variants
// are TONES ("positive", "caution", "critical", "neutral") and not bands,
// grades, severities or statuses: a tone is a reading of a value that any
// domain can map onto, and the mapping lives in `entities/` where the domain
// actually is. A `<Badge tone="critical">` in a kit that knew about heating
// bands would be a kit no second project could use.

/** PageShell — the page container r24 had to invent: measure, centring, and
 *  the vertical rhythm between a header and the content stack. */
export const PAGE_SHELL_TSX = `import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.js";

export interface PageShellProps extends ComponentProps<"main"> {
  /** The page's one \`<h1>\`. Required, because a page without a top-level
   *  heading is a page a screen reader cannot summarise and a blind test
   *  cannot name (TN-26-006). */
  readonly title: string;
  /** One line under the title saying what the screen is for. */
  readonly description?: string;
  /** Header-right slot: the page's primary actions, if it has any. */
  readonly actions?: ReactNode;
}

/**
 * The page.
 *
 * \`max-w-5xl\` is not decoration: unbounded text on a wide monitor runs to 200
 * characters a line, which is the single most common way a correct screen
 * reads as broken. The padding scale and the \`gap-6\` content stack are the
 * rest of the rhythm — spacing RELATIONSHIPS are anatomy, so they are
 * pack-owned, while every colour underneath them is a token the project owns.
 */
export function PageShell({
  title,
  description,
  actions,
  className,
  children,
  ...rest
}: PageShellProps): ReactElement {
  return (
    <main className={cn("mx-auto w-full max-w-5xl px-6 py-10", className)} {...rest}>
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description === undefined ? null : (
            <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className="flex flex-col gap-6">{children}</div>
    </main>
  );
}
`;

/** Badge — the tone chip. Four tones, each a reading rather than a domain word. */
export const BADGE_TSX = `import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.js";

/**
 * How a value READS, not what it is.
 *
 * The kit is generic by law (shared may not import a domain), so a Badge knows
 * "this is fine" / "watch it" / "act now" / "nothing to say" and nothing else.
 * Mapping a heating band, an invoice age or a build result onto one of these
 * belongs in the entity or feature slice that owns the domain.
 */
export type BadgeTone = "positive" | "caution" | "critical" | "neutral";

const TONE: Record<BadgeTone, string> = {
  positive: "bg-positive text-positive-foreground",
  caution: "bg-caution text-caution-foreground",
  critical: "bg-critical text-critical-foreground",
  neutral: "bg-neutral text-neutral-foreground",
};

// \`w-fit\` is load-bearing, and the screenshot at TN-26-006's wrap is what
// found it: a Badge dropped into a \`flex flex-col\` container (CardHeader is
// one) is a FLEX ITEM, and flex items stretch by default — \`inline-flex\`
// governs the badge's own children and does nothing about its width. The chip
// rendered as a full-width red bar, with every test still green, which is the
// exact defect class the pixels exist to catch.
const BASE =
  "inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium";

export interface BadgeProps extends ComponentProps<"span"> {
  readonly tone?: BadgeTone;
  /**
   * REQUIRED, and that is the whole accessibility design of this component.
   *
   * Colour alone is not a signal: a colour-blind reader, a greyscale print and
   * a screen reader all get nothing from a green pill. Typing \`children\` as
   * required makes a wordless Badge a COMPILE error rather than a review
   * finding — the tone decorates the text, it never replaces it.
   */
  readonly children: ReactNode;
}

export function Badge({ tone = "neutral", className, ...rest }: BadgeProps): ReactElement {
  return <span className={cn(BASE, TONE[tone], className)} {...rest} />;
}
`;

/** Stat — the metric reading r24 rendered as a bare paragraph. */
export const STAT_TSX = `import type { ComponentProps, ReactElement } from "react";
import { cn } from "../lib/cn.js";

export interface StatProps extends Omit<ComponentProps<"div">, "children"> {
  /** What the number is, in the user's words — "Flow temperature". */
  readonly label: string;
  /** The number, already formatted. Formatting is a domain decision (how many
   *  decimals a reading carries is not the kit's business), so the value
   *  arrives as text the caller rendered from its value object. */
  readonly value: string;
  /** "°C", "kWh", "days". Optional, because not every metric has one. */
  readonly unit?: string;
}

/**
 * A labelled metric.
 *
 * The unit is its OWN element rather than glued into the value string, for two
 * reasons: it can be typeset quieter than the number, and a blind test can
 * assert the number and the unit independently — \`getByText("21.5")\` does not
 * become \`getByText("21.5 °C")\` the day someone changes the spacing.
 *
 * \`tabular-nums\` makes a column of readings line up digit for digit, which is
 * the difference between a table of numbers and a ransom note.
 */
export function Stat({ label, value, unit, className, ...rest }: StatProps): ReactElement {
  return (
    <div className={cn("flex flex-col gap-1", className)} {...rest}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {unit === undefined ? null : <span className="text-sm text-muted-foreground">{unit}</span>}
      </span>
    </div>
  );
}
`;

/** DataList — a titled, spaced collection. The wrapper r24's card stack lacked. */
export const DATA_LIST_TSX = `import { useId, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { cn } from "../lib/cn.js";

export interface DataListProps extends ComponentProps<"section"> {
  /** The collection's heading — "Buildings", "Recent reports". */
  readonly title: string;
  /** Optional one-liner under the heading. */
  readonly description?: string;
  /** What to show when the collection is empty. A list with no items and no
   *  message is the screen state specs forget and users meet first. */
  readonly empty?: ReactNode;
  readonly children?: ReactNode;
}

/**
 * A titled list of things.
 *
 * It is a real \`<ul>\` with \`role="list"\` restated. Tailwind's preflight
 * removes the list marker, and a marker-less list loses its list semantics in
 * Safari's accessibility tree — so the role is written back explicitly, and
 * \`getAllByRole("listitem")\` keeps working for the test-writer who cannot see
 * the screen.
 *
 * \`aria-labelledby\` ties the section to its own heading, so a screen reader
 * announces "Buildings, list, 3 items" instead of "list, 3 items" — which on a
 * dashboard of four lists is the whole difference.
 */
export function DataList({
  title,
  description,
  empty,
  className,
  children,
  ...rest
}: DataListProps): ReactElement {
  const headingId = useId();
  const isEmpty = children === undefined || children === null || children === false;
  return (
    <section aria-labelledby={headingId} className={cn("flex flex-col gap-3", className)} {...rest}>
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-base font-semibold">
          {title}
        </h2>
        {description === undefined ? null : (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {isEmpty && empty !== undefined ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul role="list" className="flex flex-col gap-4">
          {children}
        </ul>
      )}
    </section>
  );
}

/** One row of a DataList. A real \`<li>\`, so the list has items to count. */
export function DataListItem({ className, ...rest }: ComponentProps<"li">): ReactElement {
  return <li className={cn("list-none", className)} {...rest} />;
}
`;

/** The kit's public API. `shared/ui` is a segment, not a slice, so this index
 *  is a convenience rather than a boundary the lints enforce — but importing a
 *  component through it keeps a component's own file free to move. */
export const SHARED_UI_INDEX = `export { Badge, type BadgeProps, type BadgeTone } from "./badge.js";
export { Button, type ButtonProps, type ButtonSize, type ButtonTone } from "./button.js";
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card.js";
export { DataList, DataListItem, type DataListProps } from "./data-list.js";
export { Input } from "./input.js";
export { Label } from "./label.js";
export { PageShell, type PageShellProps } from "./page-shell.js";
export { Stat, type StatProps } from "./stat.js";
`;

/** Every file of the component kit, emitted into `src/ui/shared/`. */
export const COMPONENT_KIT: readonly { readonly path: string; readonly body: string }[] = [
  { path: "src/ui/shared/lib/cn.ts", body: CN_TS },
  { path: "src/ui/shared/ui/badge.tsx", body: BADGE_TSX },
  { path: "src/ui/shared/ui/button.tsx", body: BUTTON_TSX },
  { path: "src/ui/shared/ui/card.tsx", body: CARD_TSX },
  { path: "src/ui/shared/ui/data-list.tsx", body: DATA_LIST_TSX },
  { path: "src/ui/shared/ui/index.ts", body: SHARED_UI_INDEX },
  { path: "src/ui/shared/ui/input.tsx", body: INPUT_TSX },
  { path: "src/ui/shared/ui/label.tsx", body: LABEL_TSX },
  { path: "src/ui/shared/ui/page-shell.tsx", body: PAGE_SHELL_TSX },
  { path: "src/ui/shared/ui/stat.tsx", body: STAT_TSX },
];

/**
 * The FSD layer directories, in import order — lower layers first.
 *
 * `widgets` is RESERVED, not emitted: the lints know the name and place it
 * between features and pages, so a project that grows composite blocks can add
 * the directory and be policed correctly from the first file. Emitting an empty
 * one would invite a layer nobody needs yet (TN-26-006).
 *
 * `processes` is dropped — FSD deprecated it itself.
 */
export const LAYER_NOTES: readonly { readonly dir: string; readonly note: string }[] = [
  {
    dir: "src/ui/entities",
    note: "The READ side (ADR 2026-030). One slice per domain entity: its display components and its query hooks. Each slice exposes a public API through its index; cross-slice imports target the index, never a file inside it.",
  },
  {
    dir: "src/ui/features",
    note: "The WRITE side (ADR 2026-030). One slice per user interaction: its form or action and its command hooks. May import entities and shared; never another feature's internals.",
  },
  {
    dir: "src/ui/pages",
    note: "Routes, composing features and entities into screens. The top layer: everything may be imported here, and nothing may import a page.",
  },
];
