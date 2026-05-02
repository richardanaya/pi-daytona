/**
 * pi-sandbox — Daytona Cloud Sandbox Extension
 *
 * Overrides pi's core filesystem and execution tools (read, write, edit,
 * bash, grep, find, ls) so all operations run inside an isolated Daytona
 * sandbox instead of the local machine.
 *
 * Usage:
 *   pi --sandbox my-sandbox          # connect to existing or create named sandbox
 *   pi --sandbox                     # create a new auto-named sandbox
 *   pi --sandbox --no-sandbox        # disable sandbox (fallback to local tools)
 *
 * Config: ~/.pi/sandbox.json
 *   { "daytonaApiKey": "dtn_...", "daytonaApiUrl": "https://app.daytona.io/api" }
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { Daytona, type Sandbox } from "@daytonaio/sdk";
import type {
	ExtensionAPI,
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

// ── State ───────────────────────────────────────────────────────────────────

const PI_SANDBOX_LABEL = { "created-by": "pi-sandbox" };
const PI_SANDBOX_PREFIX = "pi-sandbox-";

function prefixedName(name: string): string {
	return name.startsWith(PI_SANDBOX_PREFIX) ? name : PI_SANDBOX_PREFIX + name;
}

function randomSuffix(): string {
	return Math.random().toString(36).slice(2, 8);
}

let daytona: Daytona | null = null;
let sandbox: Sandbox | null = null;
let sandboxWorkDir = "/home/daytona/workspace";
let localCwd = process.cwd();
let configPath: string;
let sandboxEnabled = false;

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

// ── Path Mapping ────────────────────────────────────────────────────────────

function toSandboxPath(absolutePath: string): string {
	if (absolutePath.startsWith(localCwd)) {
		const relative = absolutePath.slice(localCwd.length);
		// Ensure no double slashes
		const clean = relative.startsWith("/") ? relative : "/" + relative;
		return sandboxWorkDir + clean;
	}
	// Already within sandbox or absolute sandbox path – pass through
	return absolutePath;
}

// ── Sandbox Operations Factories ────────────────────────────────────────────

function createSandboxReadOps(): ReadOperations {
	const s = sandbox!;
	return {
		readFile: async (absolutePath: string): Promise<Buffer> => {
			return s.fs.downloadFile(toSandboxPath(absolutePath));
		},
		access: async (absolutePath: string): Promise<void> => {
			// getFileDetails throws if not found / not accessible
			await s.fs.getFileDetails(toSandboxPath(absolutePath));
		},
		detectImageMimeType: async (
			absolutePath: string,
		): Promise<string | null | undefined> => {
			try {
				const sp = toSandboxPath(absolutePath);
				const result = await s.process.executeCommand(
					`file --mime-type -b "${sp}"`,
				);
				const mime = result.result.trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
					mime,
				)
					? mime
					: null;
			} catch {
				return null;
			}
		},
	};
}

function createSandboxWriteOps(): WriteOperations {
	const s = sandbox!;
	return {
		writeFile: async (absolutePath: string, content: string): Promise<void> => {
			await s.fs.uploadFile(
				Buffer.from(content, "utf-8"),
				toSandboxPath(absolutePath),
			);
		},
		mkdir: async (dir: string): Promise<void> => {
			await s.fs.createFolder(toSandboxPath(dir), "755");
		},
	};
}

function createSandboxEditOps(): EditOperations {
	const s = sandbox!;
	return {
		readFile: async (absolutePath: string): Promise<Buffer> => {
			return s.fs.downloadFile(toSandboxPath(absolutePath));
		},
		writeFile: async (absolutePath: string, content: string): Promise<void> => {
			await s.fs.uploadFile(
				Buffer.from(content, "utf-8"),
				toSandboxPath(absolutePath),
			);
		},
		access: async (absolutePath: string): Promise<void> => {
			await s.fs.getFileDetails(toSandboxPath(absolutePath));
		},
	};
}

function createSandboxBashOps(): BashOperations {
	const s = sandbox!;
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			// Map local cwd to sandbox cwd
			const sandboxCwd = cwd ? toSandboxPath(cwd) : sandboxWorkDir;

			try {
				// Daytona executeCommand doesn't stream back stdout progressively,
				// so we collect the full result and emit it once.
				const result = await s.process.executeCommand(
					command,
					sandboxCwd,
					env,
					timeout,
				);

				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				if (result.result) {
					onData(Buffer.from(result.result, "utf-8"));
				}

				return { exitCode: result.exitCode };
			} catch (err: any) {
				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}
				// Daytona errors often include the exit code and output in the message
				const exitCodeMatch = err?.message?.match(/exit code (\d+)/i);
				const exitCode = exitCodeMatch
					? Number.parseInt(exitCodeMatch[1], 10)
					: 1;
				return { exitCode };
			}
		},
	};
}

// ── Tool factories (lazily create with sandbox ops) ─────────────────────────

function buildReadTool() {
	return createReadTool(localCwd, { operations: createSandboxReadOps() });
}

function buildWriteTool() {
	return createWriteTool(localCwd, { operations: createSandboxWriteOps() });
}

function buildEditTool() {
	return createEditTool(localCwd, { operations: createSandboxEditOps() });
}

function buildBashTool() {
	return createBashTool(localCwd, { operations: createSandboxBashOps() });
}

// ── Helpers for grep/find/ls (full tool replacement) ────────────────────────

/**
 * Format matches from Daytona's findFiles (text-in-files search) into
 * a grep-like output string.
 */
function formatGrepMatches(
	matches: Array<{ file: string; line: number; content: string }>,
	limit: number,
): string {
	if (matches.length === 0) {
		return "(no matches)";
	}
	const capped = matches.slice(0, limit);
	const lines = capped.map(
		(m) => `${m.file}:${m.line}: ${m.content}`,
	);
	let output = lines.join("\n");
	if (matches.length > limit) {
		output += `\n\n[${matches.length - limit} more matches truncated, limit=${limit}]`;
	}
	return output;
}

/**
 * Format files from Daytona's searchFiles (name pattern search) into
 * a find-like output string.
 */
function formatFindResults(files: string[], limit: number): string {
	if (files.length === 0) {
		return "(no files found)";
	}
	const capped = files.slice(0, limit);
	let output = capped.join("\n");
	if (files.length > limit) {
		output += `\n\n[${files.length - limit} more results truncated, limit=${limit}]`;
	}
	return output;
}

/**
 * Format FileInfo entries into an ls-like output string.
 */
function formatLsResults(
	files: Array<{
		name: string;
		isDir: boolean;
		size: number;
		modTime: string;
		permissions: string;
	}>,
	limit: number,
): string {
	if (files.length === 0) {
		return "(empty directory)";
	}
	const capped = files.slice(0, limit);
	const lines = capped.map((f) => {
		const type = f.isDir ? "d" : "-";
		const size = String(f.size).padStart(10);
		const mod = f.modTime ? new Date(f.modTime).toISOString().split("T")[0] : "?";
		return `${type}${f.permissions || "---------"}  ${size}  ${mod}  ${f.name}${f.isDir ? "/" : ""}`;
	});
	let output = lines.join("\n");
	if (files.length > limit) {
		output += `\n\n[${files.length - limit} more entries truncated, limit=${limit}]`;
	}
	return output;
}

// ── Extension ───────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
	configPath = join(homedir(), ".pi", "sandbox.json");

	// ── Register CLI flags ───────────────────────────────────────────────

	pi.registerFlag("sandbox", {
		description:
			"Daytona sandbox ID/name to use (creates one if not found). Omit value to auto-create.",
		type: "string",
	});

	pi.registerFlag("no-sandbox", {
		description: "Disable Daytona sandbox and use local tools",
		type: "boolean",
		default: false,
	});

	// ── Register sandboxed tools (overrides built-in) ────────────────────

	// Save original built-in tools for fallback
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	// read – override with sandbox-aware execute
	pi.registerTool({
		...localRead,
		label: "read (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxEnabled || !sandbox) {
				return localRead.execute(id, params, signal, onUpdate);
			}
			return buildReadTool().execute(id, params, signal, onUpdate);
		},
	});

	// write – override with sandbox-aware execute
	pi.registerTool({
		...localWrite,
		label: "write (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxEnabled || !sandbox) {
				return localWrite.execute(id, params, signal, onUpdate);
			}
			return buildWriteTool().execute(id, params, signal, onUpdate);
		},
	});

	// edit – override with sandbox-aware execute
	pi.registerTool({
		...localEdit,
		label: "edit (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxEnabled || !sandbox) {
				return localEdit.execute(id, params, signal, onUpdate);
			}
			return buildEditTool().execute(id, params, signal, onUpdate);
		},
	});

	// bash – override with sandbox-aware execute
	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxEnabled || !sandbox) {
				return localBash.execute(id, params, signal, onUpdate);
			}
			return buildBashTool().execute(id, params, signal, onUpdate);
		},
	});

	// grep – override with Daytona-native findFiles
	const grepSchema = Type.Object({
		pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
		path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
		glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
		context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
	});

	pi.registerTool({
		name: "grep",
		label: "grep (sandboxed)",
		description:
			"Search for a pattern in files within the Daytona sandbox. Returns matching lines with file path, line number, and content.",
		promptSnippet: "Search file contents with regex",
		promptGuidelines: ["Use grep to search for patterns in code instead of terminal grep/rg."],
		parameters: grepSchema,
		async execute(
			_toolCallId,
			params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number },
			_signal,
			_onUpdate,
			_ctx,
		) {
			if (!sandboxEnabled || !sandbox) {
				const localGrep = createGrepTool(localCwd);
				return localGrep.execute(_toolCallId, params, _signal, _onUpdate);
			}
			const s = sandbox!;
			const searchPath = params.path
				? toSandboxPath(params.path.startsWith("/") ? params.path : join(localCwd, params.path))
				: toSandboxPath(localCwd);
			const limit = params.limit ?? 100;

			try {
				const matches = await s.fs.findFiles(searchPath, params.pattern);
				const output = formatGrepMatches(matches, limit);
				return {
					content: [{ type: "text" as const, text: output }],
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

	// find – override with Daytona-native searchFiles
	const findSchema = Type.Object({
		pattern: Type.String({
			description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
		}),
		path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
	});

	pi.registerTool({
		name: "find",
		label: "find (sandboxed)",
		description:
			"Find files matching a glob pattern within the Daytona sandbox. Returns matching file paths.",
		promptSnippet: "Find files by glob pattern",
		promptGuidelines: ["Use find to search for files by name instead of shell find or fd."],
		parameters: findSchema,
		async execute(
			_toolCallId,
			params: { pattern: string; path?: string; limit?: number },
			_signal,
			_onUpdate,
			_ctx,
		) {
			if (!sandboxEnabled || !sandbox) {
				const localFind = createFindTool(localCwd);
				return localFind.execute(_toolCallId, params, _signal, _onUpdate);
			}
			const s = sandbox!;
			const searchPath = params.path
				? toSandboxPath(params.path.startsWith("/") ? params.path : join(localCwd, params.path))
				: toSandboxPath(localCwd);
			const limit = params.limit ?? 1000;

			try {
				const result = await s.fs.searchFiles(searchPath, params.pattern);
				const output = formatFindResults(result.files, limit);
				return {
					content: [{ type: "text" as const, text: output }],
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

	// ls – override with Daytona-native listFiles
	const lsSchema = Type.Object({
		path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
		limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
	});

	pi.registerTool({
		name: "ls",
		label: "ls (sandboxed)",
		description:
			"List files and directories within the Daytona sandbox. Returns file names with type, size, and permissions.",
		promptSnippet: "List directory contents",
		promptGuidelines: ["Use ls to list directory contents instead of shell ls."],
		parameters: lsSchema,
		async execute(
			_toolCallId,
			params: { path?: string; limit?: number },
			_signal,
			_onUpdate,
			_ctx,
		) {
			if (!sandboxEnabled || !sandbox) {
				const localLs = createLsTool(localCwd);
				return localLs.execute(_toolCallId, params, _signal, _onUpdate);
			}
			const s = sandbox!;
			const listPath = params.path
				? toSandboxPath(params.path.startsWith("/") ? params.path : join(localCwd, params.path))
				: toSandboxPath(localCwd);
			const limit = params.limit ?? 500;

			try {
				const files = await s.fs.listFiles(listPath);
				const output = formatLsResults(files, limit);
				return {
					content: [{ type: "text" as const, text: output }],
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

	pi.on("user_bash", () => {
		if (!sandboxEnabled || !sandbox) return;
		return { operations: createSandboxBashOps() };
	});

	// ── Update system prompt to reflect sandbox working directory ────────

	pi.on("before_agent_start", async (event) => {
		if (sandboxEnabled && sandbox) {
			const modified = event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				`Current working directory: ${sandboxWorkDir} (Daytona sandbox: ${sandbox.id})`,
			);
			return { systemPrompt: modified };
		}
	});

	// ── Session start: initialize Daytona sandbox ────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const noSandbox = pi.getFlag("no-sandbox") as boolean;
		if (noSandbox) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = await loadConfig();
		const apiKey = config.daytonaApiKey;

		if (!apiKey) {
			sandboxEnabled = false;
			ctx.ui.notify(
				"Sandbox config not found. Create ~/.pi/sandbox.json with { \"daytonaApiKey\": \"dtn_...\" }",
				"warning",
			);
			return;
		}

		// Update local cwd (may change on session reload)
		localCwd = ctx.cwd;

		// Only activate sandbox when --sandbox flag is explicitly passed
		const sandboxFlag = pi.getFlag("sandbox") as string | undefined;
		if (sandboxFlag === undefined) {
			sandboxEnabled = false;
			ctx.ui.notify(
				"Sandbox mode not active. Use --sandbox <id> to connect, or --sandbox to auto-create.",
				"info",
			);
			return;
		}

		try {
			daytona = new Daytona({
				apiKey,
				apiUrl: config.daytonaApiUrl || "https://app.daytona.io/api",
				target: config.daytonaTarget || "us",
			});

			// Use flag value if non-empty, otherwise fall back to config.sandboxId
			const rawName = sandboxFlag || config.sandboxId;

			if (rawName) {
				// Try bare name first (backward compat), then prefixed name
				let found: Sandbox | null = null;
				for (const candidate of [rawName, prefixedName(rawName)]) {
					try {
						found = await daytona.get(candidate);
						break;
					} catch { /* not found, try next */ }
				}

				if (found) {
					sandbox = found;
					ctx.ui.notify(
						`Connected to existing sandbox: ${sandbox.id} (${sandbox.name || sandbox.id})`,
						"info",
					);
				} else {
					// Not found, create a new one with the prefixed name
					const name = prefixedName(rawName);
					ctx.ui.notify(
						`Sandbox "${rawName}" not found, creating "${name}"...`,
						"info",
					);
					sandbox = await daytona.create(
						{
							name,
							language: "typescript" as any,
							labels: PI_SANDBOX_LABEL,
						},
						{ timeout: 120 },
					);
					ctx.ui.notify(
						`Created sandbox: ${sandbox.id} (${name})`,
						"info",
					);
				}
			} else {
				// --sandbox passed without a value and no config fallback → auto-create
				const name = PI_SANDBOX_PREFIX + randomSuffix();
				ctx.ui.notify(`Creating Daytona sandbox "${name}"...`, "info");
				sandbox = await daytona.create(
					{
						name,
						language: "typescript" as any,
						autoStopInterval: 30,
						labels: PI_SANDBOX_LABEL,
					},
					{ timeout: 120 },
				);
				ctx.ui.notify(`Created sandbox: ${sandbox.id} (${name})`, "info");
			}

			// Resolve sandbox working directory
			try {
				const wd = await sandbox.getWorkDir();
				if (wd) sandboxWorkDir = wd;
			} catch {
				// Fall back to default
			}

			sandboxEnabled = true;

			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `🏖️ Sandbox: ${sandbox.name || sandbox.id}`),
			);
		} catch (err: any) {
			sandboxEnabled = false;
			ctx.ui.notify(
				`Sandbox initialization failed: ${err.message}`,
				"error",
			);
		}
	});

	// ── Register sandbox-list tool (LLM-callable) ────────────────────────

	const sandboxListSchema = Type.Object({});

	pi.registerTool({
		name: "sandbox-list",
		label: "sandbox-list",
		description:
			"List all Daytona sandboxes created by pi. Returns name, ID, and state for each sandbox. The currently active sandbox is marked.",
		promptSnippet: "List pi-managed Daytona sandboxes",
		promptGuidelines: [
			"Use sandbox-list to see what sandboxes exist before switching or deleting.",
		],
		parameters: sandboxListSchema,
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (!daytona) {
				const config = await loadConfig();
				if (!config.daytonaApiKey) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Not connected to Daytona. Set daytonaApiKey in ~/.pi/sandbox.json",
							},
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
				const result = await daytona.list(PI_SANDBOX_LABEL);
				if (result.items.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No pi-managed sandboxes found." }],
					};
				}

				const lines = [`pi-managed sandboxes (${result.items.length}):`, ""];
				for (const sb of result.items) {
					const marker = sandbox?.id === sb.id ? " ◀ active" : "";
					const name = sb.name || "(unnamed)";
					const state = sb.state || "?";
					lines.push(`  ${name}  [${sb.id}]  (${state})${marker}`);
				}
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { count: result.items.length },
				};
			} catch (err: any) {
				return {
					content: [
						{ type: "text" as const, text: `Failed to list sandboxes: ${err.message}` },
					],
				};
			}
		},
	});

	// ── Register sandbox-delete tool (LLM-callable) ──────────────────────

	const sandboxDeleteSchema = Type.Object({
		sandboxIds: Type.Array(Type.String(), {
			description:
				"One or more sandbox IDs or names to delete. If empty, deletes the currently active sandbox. Use sandbox-list first to find IDs.",
		}),
	});

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
		parameters: sandboxDeleteSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { sandboxIds } = params as { sandboxIds: string[] };

			if (!daytona) {
				const config = await loadConfig();
				if (!config.daytonaApiKey) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Not connected to Daytona. Set daytonaApiKey in ~/.pi/sandbox.json",
							},
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
				// If no IDs given, target the active sandbox
				const ids = sandboxIds.length > 0 ? sandboxIds : sandbox ? [sandbox.id] : [];

				if (ids.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: "No sandboxIds provided and no sandbox is currently active.",
							},
						],
					};
				}

				const results: string[] = [];
				let detached = false;

				for (const targetId of ids) {
					try {
						// Try bare name/id first, then prefixed name
						let target: Sandbox | null = null;
						for (const candidate of [targetId, prefixedName(targetId)]) {
							try {
								target = await daytona.get(candidate);
								break;
							} catch { /* not found, try next */ }
						}

						if (!target) {
							results.push(`  ✗ ${targetId}: not found`);
							continue;
						}

						const targetName = target.name || target.id;
						const wasActive = sandbox?.id === target.id;

						await daytona.delete(target);

						if (wasActive) {
							sandbox = null;
							sandboxEnabled = false;
							detached = true;
						}

						results.push(`  ✓ ${targetName} (${target.id})${wasActive ? " — detached to local mode" : ""}`);
					} catch (err: any) {
						results.push(`  ✗ ${targetId}: ${err.message}`);
					}
				}

				if (detached) {
					ctx.ui.setStatus("sandbox", undefined);
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Deleted ${ids.length} sandbox(es):\n${results.join("\n")}`,
						},
					],
					details: { deleted: ids.length },
				};
			} catch (err: any) {
				return {
					content: [
						{ type: "text" as const, text: `Failed to delete sandboxes: ${err.message}` },
					],
				};
			}
		},
	});
}
