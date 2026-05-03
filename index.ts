/**
 * pi-daytona — Daytona Cloud Sandbox Extension (v0.0.2)
 *
 * Overrides pi's core filesystem and execution tools (read, write, edit,
 * bash, grep, find, ls) so all operations run inside an isolated Daytona
 * sandbox instead of the local machine.
 *
 * v0.0.2: Per-session sandbox state — supports concurrent sessions;
 *          skill files (SKILL.md) read from local filesystem first.
 * (e.g., HTTP server with multiple clients) by keying sandbox state
 * on sessionManager.getSessionId() instead of module globals.
 *
 * Usage:
 *   pi --sandbox my-sandbox          # connect to existing or create named sandbox
 *   pi --sandbox                     # create a new auto-named sandbox
 *   pi --sandbox --no-sandbox        # disable sandbox (fallback to local tools)
 *
 * Config: ~/.pi/daytona.json
 *   { "daytonaApiKey": "dtn_...", "daytonaApiUrl": "https://app.daytona.io/api" }
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import type {
	ExtensionAPI,
	ExtensionContext,
	BashOperations,
	ReadOperations,
	WriteOperations,
	EditOperations,
} from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createReadTool,
	createWriteTool,
	createEditTool,
	createGrepTool,
	createFindTool,
	createLsTool,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

// ── Types ───────────────────────────────────────────────────────────────────

interface SandboxConfig {
	daytonaApiKey?: string;
	daytonaApiUrl?: string;
	daytonaTarget?: string;
	/** Optional sandbox name/ID to connect to instead of creating */
	sandboxId?: string;
}

/** Per-session sandbox state, keyed by sessionManager.getSessionId(). */
interface SessionState {
	sandbox: Sandbox;
	workDir: string;
	cwd: string;
	enabled: boolean;
}

// ── Constants ───────────────────────────────────────────────────────────────

const PI_DAYTONA_LABEL = { "created-by": "pi-daytona" };
const PI_DAYTONA_PREFIX = "pi-daytona-";

function prefixedName(name: string): string {
	return name.startsWith(PI_DAYTONA_PREFIX) ? name : PI_DAYTONA_PREFIX + name;
}

function randomSuffix(): string {
	return Math.random().toString(36).slice(2, 8);
}

// ── Shared state ────────────────────────────────────────────────────────────

/** Daytona API client — stateless, shared across all sessions. */
let daytona: Daytona | null = null;

/** Per-session sandbox state: sessionId → { sandbox, workDir, cwd, enabled } */
const sessions = new Map<string, SessionState>();

let configPath: string;

// ── Config ──────────────────────────────────────────────────────────────────

async function loadConfig(): Promise<SandboxConfig> {
	try {
		await access(configPath);
		const content = await readFile(configPath, "utf-8");
		return JSON.parse(content) as SandboxConfig;
	} catch {
		return {};
	}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Look up per-session state from an ExtensionContext. */
function getState(ctx: ExtensionContext): SessionState | undefined {
	return sessions.get(ctx.sessionManager.getSessionId());
}

/** Get the session's sandbox (throws if not active). */
function requireState(ctx: ExtensionContext): SessionState {
	const state = getState(ctx);
	if (!state?.enabled || !state.sandbox) {
		throw new Error("Sandbox not active for this session");
	}
	return state;
}

// ── Path Mapping (per-session) ──────────────────────────────────────────────

function toSandboxPath(state: SessionState, absolutePath: string): string {
	if (absolutePath.startsWith(state.cwd)) {
		const relative = absolutePath.slice(state.cwd.length);
		const clean = relative.startsWith("/") ? relative : "/" + relative;
		return state.workDir + clean;
	}
	// Already within sandbox or absolute sandbox path – pass through
	return absolutePath;
}

// ── Sandbox Operations Factories (per-session) ──────────────────────────────

/** Check if a read path is a skill file (SKILL.md). */
function isSkillFile(path: string): boolean {
	return path.endsWith("SKILL.md");
}

/** Try reading a file from the local filesystem first. */
async function tryLocalRead(absolutePath: string): Promise<Buffer | null> {
	try {
		const content = await readFile(absolutePath);
		return content;
	} catch {
		return null;
	}
}

function createSandboxReadOps(state: SessionState): ReadOperations {
	const s = state.sandbox;
	return {
		readFile: async (absolutePath: string): Promise<Buffer> => {
			return s.fs.downloadFile(toSandboxPath(state, absolutePath));
		},
		access: async (absolutePath: string): Promise<void> => {
			await s.fs.getFileDetails(toSandboxPath(state, absolutePath));
		},
		detectImageMimeType: async (absolutePath: string): Promise<string | null | undefined> => {
			try {
				const sp = toSandboxPath(state, absolutePath);
				const result = await s.process.executeCommand(`file --mime-type -b "${sp}"`);
				const mime = result.result.trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
			} catch {
				return null;
			}
		},
	};
}

function createSandboxWriteOps(state: SessionState): WriteOperations {
	const s = state.sandbox;
	return {
		writeFile: async (absolutePath: string, content: string): Promise<void> => {
			await s.fs.uploadFile(Buffer.from(content, "utf-8"), toSandboxPath(state, absolutePath));
		},
		mkdir: async (dir: string): Promise<void> => {
			await s.fs.createFolder(toSandboxPath(state, dir), "755");
		},
	};
}

function createSandboxEditOps(state: SessionState): EditOperations {
	const s = state.sandbox;
	return {
		readFile: async (absolutePath: string): Promise<Buffer> => {
			return s.fs.downloadFile(toSandboxPath(state, absolutePath));
		},
		writeFile: async (absolutePath: string, content: string): Promise<void> => {
			await s.fs.uploadFile(Buffer.from(content, "utf-8"), toSandboxPath(state, absolutePath));
		},
		access: async (absolutePath: string): Promise<void> => {
			await s.fs.getFileDetails(toSandboxPath(state, absolutePath));
		},
	};
}

function createSandboxBashOps(state: SessionState): BashOperations {
	const s = state.sandbox;
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("Operation aborted");

			const sandboxCwd = cwd ? toSandboxPath(state, cwd) : state.workDir;

			try {
				const result = await s.process.executeCommand(command, sandboxCwd, env, timeout);

				if (signal?.aborted) throw new Error("Operation aborted");

				if (result.result) {
					onData(Buffer.from(result.result, "utf-8"));
				}

				return { exitCode: result.exitCode };
			} catch (err: any) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const exitCodeMatch = err?.message?.match(/exit code (\d+)/i);
				return { exitCode: exitCodeMatch ? Number.parseInt(exitCodeMatch[1], 10) : 1 };
			}
		},
	};
}

// ── Tool builders (per-session) ─────────────────────────────────────────────

function buildReadTool(state: SessionState) {
	return createReadTool(state.cwd, { operations: createSandboxReadOps(state) });
}

function buildWriteTool(state: SessionState) {
	return createWriteTool(state.cwd, { operations: createSandboxWriteOps(state) });
}

function buildEditTool(state: SessionState) {
	return createEditTool(state.cwd, { operations: createSandboxEditOps(state) });
}

function buildBashTool(state: SessionState) {
	return createBashTool(state.cwd, { operations: createSandboxBashOps(state) });
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatGrepMatches(
	matches: Array<{ file: string; line: number; content: string }>,
	limit: number,
): string {
	if (matches.length === 0) return "(no matches)";
	const capped = matches.slice(0, limit);
	const lines = capped.map((m) => `${m.file}:${m.line}: ${m.content}`);
	let output = lines.join("\n");
	if (matches.length > limit) output += `\n\n[${matches.length - limit} more matches truncated, limit=${limit}]`;
	return output;
}

function formatFindResults(files: string[], limit: number): string {
	if (files.length === 0) return "(no files found)";
	const capped = files.slice(0, limit);
	let output = capped.join("\n");
	if (files.length > limit) output += `\n\n[${files.length - limit} more results truncated, limit=${limit}]`;
	return output;
}

function formatLsResults(
	files: Array<{ name: string; isDir: boolean; size: number; modTime: string; permissions: string }>,
	limit: number,
): string {
	if (files.length === 0) return "(empty directory)";
	const capped = files.slice(0, limit);
	const lines = capped.map((f) => {
		const type = f.isDir ? "d" : "-";
		const size = String(f.size).padStart(10);
		const mod = f.modTime ? new Date(f.modTime).toISOString().split("T")[0] : "?";
		return `${type}${f.permissions || "---------"}  ${size}  ${mod}  ${f.name}${f.isDir ? "/" : ""}`;
	});
	let output = lines.join("\n");
	if (files.length > limit) output += `\n\n[${files.length - limit} more entries truncated, limit=${limit}]`;
	return output;
}

// ── Extension ───────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	configPath = join(homedir(), ".pi", "daytona.json");

	// ── Register CLI flags ───────────────────────────────────────────────

	pi.registerFlag("sandbox", {
		description: "Daytona sandbox ID/name to use (creates one if not found). Omit value to auto-create.",
		type: "string",
	});

	pi.registerFlag("no-sandbox", {
		description: "Disable Daytona sandbox and use local tools",
		type: "boolean",
		default: false,
	});

	// ── Local fallback tools (cwd resolved at call time via ctx) ──────────

	const defaultCwd = process.cwd();
	const localRead = createReadTool(defaultCwd);
	const localWrite = createWriteTool(defaultCwd);
	const localEdit = createEditTool(defaultCwd);
	const localBash = createBashTool(defaultCwd);

	// ── Register sandboxed tools (overrides built-in) ────────────────────

	// read
	pi.registerTool({
		...localRead,
		label: "read (sandboxed)",
		async execute(id, params, signal, onUpdate, ctx) {
			const state = getState(ctx as ExtensionContext);
			if (!state?.enabled || !state.sandbox) {
				return localRead.execute(id, params, signal, onUpdate);
			}

			const readParams = params as { path: string; offset?: number; limit?: number };
			if (isSkillFile(readParams.path)) {
				const localContent = await tryLocalRead(readParams.path);
				if (localContent !== null) {
					return localRead.execute(id, params, signal, onUpdate);
				}
			}

			return buildReadTool(state).execute(id, params, signal, onUpdate);
		},
	});

	// write
	pi.registerTool({
		...localWrite,
		label: "write (sandboxed)",
		async execute(id, params, signal, onUpdate, ctx) {
			const state = getState(ctx as ExtensionContext);
			if (!state?.enabled || !state.sandbox) {
				return localWrite.execute(id, params, signal, onUpdate);
			}
			return buildWriteTool(state).execute(id, params, signal, onUpdate);
		},
	});

	// edit
	pi.registerTool({
		...localEdit,
		label: "edit (sandboxed)",
		async execute(id, params, signal, onUpdate, ctx) {
			const state = getState(ctx as ExtensionContext);
			if (!state?.enabled || !state.sandbox) {
				return localEdit.execute(id, params, signal, onUpdate);
			}
			return buildEditTool(state).execute(id, params, signal, onUpdate);
		},
	});

	// bash
	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, ctx) {
			const state = getState(ctx as ExtensionContext);
			if (!state?.enabled || !state.sandbox) {
				return localBash.execute(id, params, signal, onUpdate);
			}
			return buildBashTool(state).execute(id, params, signal, onUpdate);
		},
	});

	// grep
	pi.registerTool({
		name: "grep",
		label: "grep (sandboxed)",
		description: "Search for a pattern in files within the Daytona sandbox. Returns matching lines with file path, line number, and content.",
		promptSnippet: "Search file contents with regex",
		promptGuidelines: ["Use grep to search for patterns in code instead of terminal grep/rg."],
		parameters: Type.Object({
			pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
			path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
			glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
			ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
			literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
			context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
		}),
		async execute(
			toolCallId,
			params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number },
			signal,
			onUpdate,
			ctx,
		) {
			const state = getState(ctx as ExtensionContext);
			if (!state?.enabled || !state.sandbox) {
				const localGrep = createGrepTool(defaultCwd);
				return localGrep.execute(toolCallId, params, signal, onUpdate);
			}
			const s = state.sandbox;
			const searchPath = params.path
				? toSandboxPath(state, params.path.startsWith("/") ? params.path : join(state.cwd, params.path))
				: toSandboxPath(state, state.cwd);
			const limit = params.limit ?? 100;

			try {
				const matches = await s.fs.findFiles(searchPath, params.pattern);
				return {
					content: [{ type: "text" as const, text: formatGrepMatches(matches, limit) }],
					details: { matchCount: matches.length },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `grep error: ${err.message}` }],
					details: { error: true },
				};
			}
		},
	});

	// find
	pi.registerTool({
		name: "find",
		label: "find (sandboxed)",
		description: "Find files matching a glob pattern within the Daytona sandbox. Returns matching file paths.",
		promptSnippet: "Find files by glob pattern",
		promptGuidelines: ["Use find to search for files by name instead of shell find or fd."],
		parameters: Type.Object({
			pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
			path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
		}),
		async execute(
			toolCallId,
			params: { pattern: string; path?: string; limit?: number },
			signal,
			onUpdate,
			ctx,
		) {
			const state = getState(ctx as ExtensionContext);
			if (!state?.enabled || !state.sandbox) {
				const localFind = createFindTool(defaultCwd);
				return localFind.execute(toolCallId, params, signal, onUpdate);
			}
			const s = state.sandbox;
			const searchPath = params.path
				? toSandboxPath(state, params.path.startsWith("/") ? params.path : join(state.cwd, params.path))
				: toSandboxPath(state, state.cwd);
			const limit = params.limit ?? 1000;

			try {
				const result = await s.fs.searchFiles(searchPath, params.pattern);
				return {
					content: [{ type: "text" as const, text: formatFindResults(result.files, limit) }],
					details: { fileCount: result.files.length },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `find error: ${err.message}` }],
					details: { error: true },
				};
			}
		},
	});

	// ls
	pi.registerTool({
		name: "ls",
		label: "ls (sandboxed)",
		description: "List files and directories within the Daytona sandbox. Returns file names with type, size, and permissions.",
		promptSnippet: "List directory contents",
		promptGuidelines: ["Use ls to list directory contents instead of shell ls."],
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
		}),
		async execute(
			toolCallId,
			params: { path?: string; limit?: number },
			signal,
			onUpdate,
			ctx,
		) {
			const state = getState(ctx as ExtensionContext);
			if (!state?.enabled || !state.sandbox) {
				const localLs = createLsTool(defaultCwd);
				return localLs.execute(toolCallId, params, signal, onUpdate);
			}
			const s = state.sandbox;
			const listPath = params.path
				? toSandboxPath(state, params.path.startsWith("/") ? params.path : join(state.cwd, params.path))
				: toSandboxPath(state, state.cwd);
			const limit = params.limit ?? 500;

			try {
				const files = await s.fs.listFiles(listPath);
				return {
					content: [{ type: "text" as const, text: formatLsResults(files, limit) }],
					details: { entryCount: files.length },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `ls error: ${err.message}` }],
					details: { error: true },
				};
			}
		},
	});

	// ── Handle user ! commands via sandbox ───────────────────────────────

	pi.on("user_bash", (_event, ctx) => {
		const state = getState(ctx);
		if (!state?.enabled || !state.sandbox) return;
		return { operations: createSandboxBashOps(state) };
	});

	// ── Update system prompt to reflect sandbox working directory ────────

	pi.on("before_agent_start", async (event, ctx) => {
		const state = getState(ctx);
		if (state?.enabled && state.sandbox) {
			const modified = event.systemPrompt.replace(
				`Current working directory: ${state.cwd}`,
				`Current working directory: ${state.workDir} (Daytona sandbox: ${state.sandbox.id})`,
			);
			return { systemPrompt: modified };
		}
	});

	// ── Session start: initialize Daytona sandbox ────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();

		// Check if this session already has sandbox state (e.g., on reload)
		if (sessions.has(sessionId)) {
			return;
		}

		const noSandbox = pi.getFlag("no-sandbox") as boolean;
		if (noSandbox) {
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = await loadConfig();
		const apiKey = config.daytonaApiKey;

		if (!apiKey) {
			ctx.ui.notify(
				'Sandbox config not found. Create ~/.pi/daytona.json with { "daytonaApiKey": "dtn_..." }',
				"warning",
			);
			return;
		}

		// Only activate sandbox when --sandbox flag is explicitly passed
		const sandboxFlag = pi.getFlag("sandbox") as string | undefined;
		if (sandboxFlag === undefined) {
			ctx.ui.notify(
				"Sandbox mode not active. Use --sandbox <id> to connect, or --sandbox to auto-create.",
				"info",
			);
			return;
		}

		try {
			// Lazy-init shared Daytona client
			if (!daytona) {
				daytona = new Daytona({
					apiKey,
					apiUrl: config.daytonaApiUrl || "https://app.daytona.io/api",
					target: config.daytonaTarget || "us",
				});
			}

			const cwd = ctx.cwd;
			let sandbox: Sandbox;
			const rawName = sandboxFlag || config.sandboxId;

			if (rawName) {
				// Try bare name first (backward compat), then prefixed name
				let found: Sandbox | null = null;
				for (const candidate of [rawName, prefixedName(rawName)]) {
					try {
						found = await daytona!.get(candidate);
						break;
					} catch {
						/* not found, try next */
					}
				}

				if (found) {
					sandbox = found;
					ctx.ui.notify(`Connected to existing sandbox: ${sandbox.id} (${sandbox.name || sandbox.id})`, "info");
				} else {
					const name = prefixedName(rawName);
					ctx.ui.notify(`Sandbox "${rawName}" not found, creating "${name}"...`, "info");
					sandbox = await daytona!.create(
						{ name, language: "typescript" as any, labels: PI_DAYTONA_LABEL },
						{ timeout: 120 },
					);
					ctx.ui.notify(`Created sandbox: ${sandbox.id} (${name})`, "info");
				}
			} else {
				// Auto-create
				const name = PI_DAYTONA_PREFIX + randomSuffix();
				ctx.ui.notify(`Creating Daytona sandbox "${name}"...`, "info");
				sandbox = await daytona!.create(
					{ name, language: "typescript" as any, autoStopInterval: 30, labels: PI_DAYTONA_LABEL },
					{ timeout: 120 },
				);
				ctx.ui.notify(`Created sandbox: ${sandbox.id} (${name})`, "info");
			}

			// Resolve sandbox working directory
			let workDir = "/home/daytona/workspace";
			try {
				const wd = await sandbox.getWorkDir();
				if (wd) workDir = wd;
			} catch {
				// Fall back to default
			}

			// Store per-session state
			sessions.set(sessionId, { sandbox, workDir, cwd, enabled: true });

			ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", `🏖️ Sandbox: ${sandbox.name || sandbox.id}`));
		} catch (err: any) {
			ctx.ui.notify(`Sandbox initialization failed: ${err.message}`, "error");
		}
	});

	// ── Session shutdown: clean up if session is being replaced/ended ────

	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		// Keep the sandbox alive (don't delete), just remove our local state.
		// Sandboxes auto-stop after idle timeout. Users can explicitly delete
		// via sandbox-delete.
		sessions.delete(sessionId);
	});

	// ── sandbox-list tool ────────────────────────────────────────────────

	pi.registerTool({
		name: "sandbox-list",
		label: "sandbox-list",
		description:
			"List all Daytona sandboxes created by pi. Returns name, ID, and state for each sandbox. The currently active sandbox is marked.",
		promptSnippet: "List pi-managed Daytona sandboxes",
		promptGuidelines: [
			"Use sandbox-list to see what sandboxes exist before switching or deleting.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!daytona) {
				const config = await loadConfig();
				if (!config.daytonaApiKey) {
					return {
						content: [
							{ type: "text" as const, text: "Not connected to Daytona. Set daytonaApiKey in ~/.pi/daytona.json" },
						],
					};
				}
				daytona = new Daytona({
					apiKey: config.daytonaApiKey,
					apiUrl: config.daytonaApiUrl || "https://app.daytona.io/api",
					target: config.daytonaTarget || "us",
				});
			}

			try {
				const result = await daytona.list(PI_DAYTONA_LABEL);
				if (result.items.length === 0) {
					return { content: [{ type: "text" as const, text: "No pi-managed sandboxes found." }] };
				}

				// Collect active sandbox IDs across all sessions
				const activeIds = new Set<string>();
				for (const state of sessions.values()) {
					if (state.enabled && state.sandbox) {
						activeIds.add(state.sandbox.id);
					}
				}

				const lines = [`pi-managed sandboxes (${result.items.length}):`, ""];
				for (const sb of result.items) {
					const marker = activeIds.has(sb.id) ? " ◀ active" : "";
					const name = sb.name || "(unnamed)";
					const st = sb.state || "?";
					lines.push(`  ${name}  [${sb.id}]  (${st})${marker}`);
				}
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { count: result.items.length },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `Failed to list sandboxes: ${err.message}` }],
				};
			}
		},
	});

	// ── sandbox-delete tool ──────────────────────────────────────────────

	pi.registerTool({
		name: "sandbox-delete",
		label: "sandbox-delete",
		description:
			"Delete one or more Daytona sandboxes by ID or name. Pass sandboxIds as an array. If the array is empty, deletes the currently active sandbox and detaches to local mode. Use sandbox-list first to see available sandboxes.",
		promptSnippet: "Delete Daytona sandboxes by ID",
		promptGuidelines: [
			"Use sandbox-list before sandbox-delete to confirm which sandboxes to remove.",
			"Deleting the active sandbox will detach pi and switch back to local tools.",
		],
		parameters: Type.Object({
			sandboxIds: Type.Array(Type.String(), {
				description: "One or more sandbox IDs or names to delete. If empty, deletes the currently active sandbox. Use sandbox-list first to find IDs.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { sandboxIds } = params as { sandboxIds: string[] };
			const extCtx = ctx as ExtensionContext;

			if (!daytona) {
				const config = await loadConfig();
				if (!config.daytonaApiKey) {
					return {
						content: [
							{ type: "text" as const, text: "Not connected to Daytona. Set daytonaApiKey in ~/.pi/daytona.json" },
						],
					};
				}
				daytona = new Daytona({
					apiKey: config.daytonaApiKey,
					apiUrl: config.daytonaApiUrl || "https://app.daytona.io/api",
					target: config.daytonaTarget || "us",
				});
			}

			try {
				// If no IDs given, target the calling session's sandbox
				const currentState = getState(extCtx);
				const ids =
					sandboxIds.length > 0
						? sandboxIds
						: currentState?.sandbox
							? [currentState.sandbox.id]
							: [];

				if (ids.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No sandboxIds provided and no sandbox is currently active for this session." }],
					};
				}

				const results: string[] = [];
				let callerDetached = false;

				for (const targetId of ids) {
					try {
						// Try bare name/id first, then prefixed name
						let target: Sandbox | null = null;
						for (const candidate of [targetId, prefixedName(targetId)]) {
							try {
								target = await daytona!.get(candidate);
								break;
							} catch {
								/* not found, try next */
							}
						}

						if (!target) {
							results.push(`  ✗ ${targetId}: not found`);
							continue;
						}

						const targetName = target.name || target.id;

						// Detach any sessions using this sandbox
						for (const [sid, state] of sessions) {
							if (state.sandbox?.id === target.id) {
								sessions.set(sid, { ...state, enabled: false, sandbox: undefined as any });
								if (sid === extCtx.sessionManager.getSessionId()) {
									callerDetached = true;
								}
							}
						}

						await daytona!.delete(target);

						const detachedNote = callerDetached ? " — detached to local mode" : "";
						results.push(`  ✓ ${targetName} (${target.id})${detachedNote}`);
					} catch (err: any) {
						results.push(`  ✗ ${targetId}: ${err.message}`);
					}
				}

				if (callerDetached) {
					extCtx.ui.setStatus("sandbox", undefined);
				}

				return {
					content: [{ type: "text" as const, text: `Deleted ${ids.length} sandbox(es):\n${results.join("\n")}` }],
					details: { deleted: ids.length },
				};
			} catch (err: any) {
				return {
					content: [{ type: "text" as const, text: `Failed to delete sandboxes: ${err.message}` }],
				};
			}
		},
	});
}
