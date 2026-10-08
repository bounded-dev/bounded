/**
 * Web Extension — web_search + web_fetch
 *
 * Tools:
 *   web_search(query, count?)  — Brave Search API if a Brave key is configured,
 *                                otherwise Mojeek HTML scrape (no key needed).
 *   web_fetch(url, maxChars?)  — Fetch a URL and return readable text
 *                                (HTML stripped, truncated).
 *
 * Brave key resolution (first hit wins):
 *   1. BRAVE_API_KEY in the process env (shell override).
 *   2. ../web-search.json relative to this file — gitignored, lives in the
 *      harness root: {"BRAVE_API_KEY": "..."}. This is the reliable path for
 *      GUI-launched sessions, which don't inherit shell env (ADR 2026-002).
 *
 * Free tier: https://brave.com/search/api/ — 2,000 queries/month.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const DEFAULT_MAX_CHARS = 8000;
const HARD_MAX_CHARS = 40000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#039;|&apos;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, " "));
}

function htmlToText(html: string): string {
	let out = html;
	// Drop non-content blocks entirely
	out = out.replace(/<script[\s\S]*?<\/script>/gi, " ");
	out = out.replace(/<style[\s\S]*?<\/style>/gi, " ");
	out = out.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
	out = out.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
	out = out.replace(/<!--[\s\S]*?-->/g, " ");
	// Line breaks for block-level structure
	out = out.replace(
		/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|nav|main|aside|blockquote|pre|figure|figcaption)[^>]*>/gi,
		"\n",
	);
	out = stripTags(out);
	// Collapse whitespace
	out = out.replace(/[ \t]+/g, " ");
	out = out.replace(/\n\s+/g, "\n");
	out = out.replace(/\n{3,}/g, "\n\n");
	return out.trim();
}

async function fetchUrl(url: string, signal?: AbortSignal): Promise<{ body: string; contentType: string; status: number }> {
	const res = await fetch(url, {
		headers: {
			"User-Agent": UA,
			Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
			"Accept-Language": "en-GB,en;q=0.9",
		},
		redirect: "follow",
		signal: signal ?? AbortSignal.timeout(20000),
	});
	const contentType = res.headers.get("content-type") ?? "";
	const body = await res.text();
	return { body, contentType, status: res.status };
}

// ---------------------------------------------------------------------------
// Search backends
// ---------------------------------------------------------------------------

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

async function searchBrave(query: string, count: number, apiKey: string, signal?: AbortSignal): Promise<SearchResult[]> {
	const res = await fetch(
		`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
		{
			headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
			signal: signal ?? AbortSignal.timeout(15000),
		},
	);
	if (!res.ok) throw new Error(`Brave Search API error: ${res.status} ${await res.text()}`);
	const data = (await res.json()) as {
		web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
	};
	return (data.web?.results ?? []).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.description ?? "",
	}));
}

function braveApiKey(): string | undefined {
	if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;
	try {
		const configPath = fileURLToPath(new URL("../web-search.json", import.meta.url));
		const config = JSON.parse(readFileSync(configPath, "utf8")) as { BRAVE_API_KEY?: unknown };
		return typeof config.BRAVE_API_KEY === "string" && config.BRAVE_API_KEY.length > 0
			? config.BRAVE_API_KEY
			: undefined;
	} catch {
		return undefined; // no config file, or malformed — fall back to Mojeek
	}
}

async function searchMojeek(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	// Mojeek expects form-style encoding (spaces as '+'); %20 returns an empty page.
	const q = encodeURIComponent(query).replace(/%20/g, "+");
	const { body } = await fetchUrl(`https://www.mojeek.com/search?q=${q}`, signal);
	const results: SearchResult[] = [];
	// Result titles look like: <h2><a class="title" ... href="URL">Title</a></h2>.
	// Mojeek wraps results in varying markup (<li>, <li class="ob">, etc.), so we
	// scan globally for title links and look for a <p class="s"> snippet nearby.
	const linkRegex = /<h2><a class="title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g;
	let m: RegExpExecArray | null;
	while ((m = linkRegex.exec(body)) !== null && results.length < count) {
		const after = body.slice(m.index, m.index + 2000);
		const snippetMatch = /<p class="s">([\s\S]*?)<\/p>/.exec(after);
		results.push({
			title: stripTags(m[2]).trim(),
			url: decodeEntities(m[1]),
			snippet: snippetMatch ? stripTags(snippetMatch[1]).trim() : "",
		});
	}
	if (results.length === 0) {
		throw new Error(
			"Mojeek returned no parseable results (possibly rate-limited). Set BRAVE_API_KEY for a reliable search backend.",
		);
	}
	return results;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** web_fetch result details — one consistent shape across all return paths. */
interface FetchDetails {
	status?: number;
	contentType?: string;
	truncated?: boolean;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web. Returns titles, URLs, and snippets. Uses Brave Search API when BRAVE_API_KEY is set, otherwise Mojeek (key-free).",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			count: Type.Optional(Type.Number({ description: "Max results (default 8, max 20)" })),
		}),
		async execute(_toolCallId, params, signal) {
			const count = Math.min(Math.max(params.count ?? 8, 1), 20);
			const braveKey = braveApiKey();
			const backend = braveKey ? "brave" : "mojeek";
			const results = braveKey
				? await searchBrave(params.query, count, braveKey, signal)
				: await searchMojeek(params.query, count, signal);

			const text =
				`Search: "${params.query}" (backend: ${backend}, ${results.length} results)\n\n` +
				results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");

			return { content: [{ type: "text", text }], details: { backend, results } };
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return its content as readable text. HTML is stripped to text. JSON/plain text returned as-is. Truncated to maxChars.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch (http/https)" }),
			maxChars: Type.Optional(
				Type.Number({ description: `Max characters to return (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS})` }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			if (!/^https?:\/\//i.test(params.url)) {
				return {
					content: [{ type: "text", text: `Error: only http/https URLs are supported, got: ${params.url}` }],
					details: {} as FetchDetails,
					isError: true,
				};
			}

			const maxChars = Math.min(Math.max(params.maxChars ?? DEFAULT_MAX_CHARS, 500), HARD_MAX_CHARS);

			try {
				const { body, contentType, status } = await fetchUrl(params.url, signal);
				if (status >= 400) {
					return {
						content: [{ type: "text", text: `HTTP ${status} fetching ${params.url}\n\n${body.slice(0, 1000)}` }],
						details: { status } as FetchDetails,
						isError: true,
					};
				}

				let text: string;
				if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
					text = htmlToText(body);
				} else if (/text\/|application\/(json|xml|javascript)/.test(contentType) || contentType === "") {
					text = body;
				} else {
					return {
						content: [{ type: "text", text: `Unsupported content type "${contentType}" at ${params.url}` }],
						details: { status, contentType } as FetchDetails,
						isError: true,
					};
				}

				const truncated = text.length > maxChars;
				if (truncated) text = text.slice(0, maxChars);

				return {
					content: [
						{
							type: "text",
							text: `Fetched ${params.url} (${contentType}, HTTP ${status}${truncated ? `, truncated to ${maxChars} chars` : ""})\n\n${text}`,
						},
					],
					details: { status, contentType, truncated } as FetchDetails,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error fetching ${params.url}: ${msg}` }],
					details: {} as FetchDetails,
					isError: true,
				};
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!braveApiKey()) {
			ctx.ui.setStatus("web", "web: mojeek (no Brave key)");
		}
	});
}
