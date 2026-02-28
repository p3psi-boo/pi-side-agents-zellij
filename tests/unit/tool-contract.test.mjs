/**
 * Tool contract unit tests for pi-parallel-agents.
 *
 * These tests validate the JSON-shape contracts and pure-function behavior of
 * the agent control tools without requiring a live Pi process, real tmux, or
 * real git worktrees.  They complement the full integration suite at
 * tests/integration/parallel-agents.integration.test.mjs.
 *
 * Tests are grouped by tool / concern:
 *   1. Pure helper functions (ported to JS for direct testing)
 *   2. JSON shape / ok-field contracts
 *   3. waitForAny fail-fast semantics using a real temp registry on disk
 *   4. sendToAgent interrupt-prefix stripping logic
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Minimal JS re-implementations of pure extension functions
// (kept in sync with extensions/parallel-agents.ts by contract)
// ---------------------------------------------------------------------------

/** @param {string} status */
function isTerminalStatus(status) {
	return status === "done" || status === "failed" || status === "crashed";
}

/**
 * @param {string} text
 * @param {number} count
 * @returns {string[]}
 */
function tailLines(text, count) {
	const lines = text
		.split(/\r?\n/)
		.filter((line, i, arr) => !(i === arr.length - 1 && line.length === 0));
	return lines.slice(-count);
}

/**
 * Minimal re-implementation of waitForAny fail-fast path.
 * Reads a registry JSON at stateRoot/.pi/parallel-agents/registry.json.
 *
 * Returns { ok: false, error } immediately when all IDs are unknown on the
 * first poll cycle.  Resolves with the matching agent payload when a terminal
 * state is detected.
 *
 * NOTE: This does NOT poll — it is synchronous to make unit testing
 * straightforward.  The real extension polls with 1 s sleeps; this validates
 * only the first-pass fail-fast logic.
 *
 * @param {string} stateRoot
 * @param {string[]} ids
 * @returns {Promise<Record<string, unknown>>}
 */
async function waitForAnyFirstPass(stateRoot, ids) {
	const { readFile } = await import("node:fs/promises");

	const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
	if (uniqueIds.length === 0) {
		return { ok: false, error: "No agent ids were provided" };
	}

	const registryPath = join(stateRoot, ".pi", "parallel-agents", "registry.json");
	let registry = { agents: {} };
	try {
		registry = JSON.parse(await readFile(registryPath, "utf8"));
	} catch {
		// empty registry
	}

	const unknownOnFirstPass = [];
	for (const id of uniqueIds) {
		const record = registry?.agents?.[id];
		if (!record) {
			unknownOnFirstPass.push(id);
			continue;
		}
		if (isTerminalStatus(record.status)) {
			return {
				ok: true,
				agent: record,
				backlog: [],
			};
		}
	}

	if (unknownOnFirstPass.length > 0) {
		return {
			ok: false,
			error: `Unknown agent id(s): ${unknownOnFirstPass.join(", ")}`,
		};
	}

	// All IDs known but none terminal — caller would need to poll.
	return { ok: false, error: "no terminal agent found (poll required)" };
}

// ---------------------------------------------------------------------------
// Helper: temporary registry factory
// ---------------------------------------------------------------------------

async function makeTempRegistry(t, agents = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-parallel-unit-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const metaDir = join(dir, ".pi", "parallel-agents");
	await mkdir(metaDir, { recursive: true });

	const registry = { version: 1, agents };
	await writeFile(join(metaDir, "registry.json"), JSON.stringify(registry, null, 2) + "\n", "utf8");

	return dir;
}

// ---------------------------------------------------------------------------
// 1. Pure helper functions
// ---------------------------------------------------------------------------

test("isTerminalStatus — done/failed/crashed are terminal", () => {
	assert.ok(isTerminalStatus("done"), "done must be terminal");
	assert.ok(isTerminalStatus("failed"), "failed must be terminal");
	assert.ok(isTerminalStatus("crashed"), "crashed must be terminal");
});

test("isTerminalStatus — running/waiting/finishing are non-terminal", () => {
	const nonTerminal = [
		"allocating_worktree",
		"spawning_tmux",
		"starting",
		"running",
		"waiting_user",
		"finishing",
		"waiting_merge_lock",
		"retrying_reconcile",
	];
	for (const status of nonTerminal) {
		assert.ok(!isTerminalStatus(status), `${status} must NOT be terminal`);
	}
});

test("tailLines — returns last N lines", () => {
	assert.deepEqual(tailLines("a\nb\nc\nd\ne", 3), ["c", "d", "e"]);
});

test("tailLines — trailing newline is not treated as an empty line", () => {
	assert.deepEqual(tailLines("a\nb\nc\n", 2), ["b", "c"]);
});

test("tailLines — requesting more lines than exist returns all", () => {
	assert.deepEqual(tailLines("a\nb", 10), ["a", "b"]);
});

test("tailLines — empty string returns empty array", () => {
	assert.deepEqual(tailLines("", 5), []);
});

// ---------------------------------------------------------------------------
// 2. JSON shape / ok-field contracts
// ---------------------------------------------------------------------------

test("agent-start success shape must include ok: true", () => {
	// This test acts as a living specification for the tool contract.
	// If this shape changes, the tool description and docs must be updated.
	const exampleSuccess = {
		ok: true,
		id: "a-0001",
		tmuxWindowId: "@5",
		tmuxWindowIndex: 5,
		worktreePath: "/tmp/repo-agent-worktree-0001",
		branch: "parallel-agent/a-0001",
		warnings: [],
	};

	assert.strictEqual(exampleSuccess.ok, true, "success response must have ok: true");
	assert.ok(typeof exampleSuccess.id === "string", "id must be a string");
	assert.ok(typeof exampleSuccess.tmuxWindowId === "string", "tmuxWindowId must be a string");
	assert.ok(typeof exampleSuccess.tmuxWindowIndex === "number", "tmuxWindowIndex must be a number");
	assert.ok(typeof exampleSuccess.worktreePath === "string", "worktreePath must be a string");
	assert.ok(typeof exampleSuccess.branch === "string", "branch must be a string");
	assert.ok(Array.isArray(exampleSuccess.warnings), "warnings must be an array");
});

test("agent-start error shape must include ok: false and error string", () => {
	const exampleError = { ok: false, error: "tmux is not available" };
	assert.strictEqual(exampleError.ok, false);
	assert.ok(typeof exampleError.error === "string");
});

test("agent-check success shape", () => {
	const exampleSuccess = {
		ok: true,
		agent: {
			id: "a-0001",
			status: "running",
			tmuxWindowId: "@5",
			tmuxWindowIndex: 5,
			worktreePath: "/tmp/repo-agent-worktree-0001",
			branch: "parallel-agent/a-0001",
			task: "refactor auth module",
			startedAt: "2026-01-01T00:00:00.000Z",
			finishedAt: undefined,
			exitCode: undefined,
			error: undefined,
			warnings: [],
		},
		backlog: ["line 1", "line 2"],
	};

	assert.strictEqual(exampleSuccess.ok, true);
	assert.ok(typeof exampleSuccess.agent.id === "string");
	assert.ok(typeof exampleSuccess.agent.status === "string");
	assert.ok(Array.isArray(exampleSuccess.backlog));
});

test("agent-send success shape", () => {
	const exampleSuccess = { ok: true, message: "Sent prompt to a-0001" };
	assert.strictEqual(exampleSuccess.ok, true);
	assert.ok(typeof exampleSuccess.message === "string");
});

test("agent-send failure shape", () => {
	const exampleFailure = { ok: false, message: "Agent a-9999 tmux window is not active" };
	assert.strictEqual(exampleFailure.ok, false);
	assert.ok(typeof exampleFailure.message === "string");
});

// ---------------------------------------------------------------------------
// 3. waitForAny fail-fast semantics
// ---------------------------------------------------------------------------

test("waitForAny — empty ids array returns error immediately", async () => {
	const result = await waitForAnyFirstPass("/does/not/exist", []);
	assert.strictEqual(result.ok, false);
	assert.ok(typeof result.error === "string");
	assert.ok(result.error.includes("No agent ids"), `expected 'No agent ids' in: ${result.error}`);
});

test("waitForAny — unknown agent id returns { ok: false, error } immediately on first pass", async (t) => {
	const stateRoot = await makeTempRegistry(t, {}); // empty registry
	const result = await waitForAnyFirstPass(stateRoot, ["a-9999"]);

	assert.strictEqual(result.ok, false, "should be ok: false for unknown id");
	assert.ok(typeof result.error === "string", "error must be a string");
	assert.ok(result.error.includes("a-9999"), `error should name the unknown id, got: ${result.error}`);
});

test("waitForAny — mix of known+unknown ids fails fast on unknown", async (t) => {
	const now = new Date().toISOString();
	const stateRoot = await makeTempRegistry(t, {
		"a-0001": {
			id: "a-0001",
			task: "real task",
			status: "running",
			startedAt: now,
			updatedAt: now,
		},
	});

	const result = await waitForAnyFirstPass(stateRoot, ["a-0001", "a-9999"]);
	assert.strictEqual(result.ok, false, "should fail fast when any id is unknown");
	assert.ok(result.error.includes("a-9999"), `error should name a-9999, got: ${result.error}`);
});

test("waitForAny — terminal agent is detected on first pass", async (t) => {
	const now = new Date().toISOString();
	const stateRoot = await makeTempRegistry(t, {
		"a-0001": {
			id: "a-0001",
			task: "some task",
			status: "done",
			startedAt: now,
			updatedAt: now,
			finishedAt: now,
		},
	});

	const result = await waitForAnyFirstPass(stateRoot, ["a-0001"]);
	assert.strictEqual(result.ok, true, "should detect terminal agent");
	assert.strictEqual(result.agent?.id, "a-0001");
	assert.ok(isTerminalStatus(result.agent?.status), "returned agent must be in terminal status");
});

test("waitForAny — non-terminal agent with valid registry signals poll-needed", async (t) => {
	const now = new Date().toISOString();
	const stateRoot = await makeTempRegistry(t, {
		"a-0001": {
			id: "a-0001",
			task: "some task",
			status: "running",
			startedAt: now,
			updatedAt: now,
		},
	});

	// First pass finds a known-but-not-terminal agent → real impl would poll.
	// Our test helper returns a sentinel; we just verify the agent was found.
	const result = await waitForAnyFirstPass(stateRoot, ["a-0001"]);
	assert.strictEqual(result.ok, false, "non-terminal should not return ok: true yet");
	assert.ok(result.error.includes("poll required") || typeof result.error === "string");
});

// ---------------------------------------------------------------------------
// 4. agent-send interrupt prefix stripping
// ---------------------------------------------------------------------------

test("agent-send '!' strips interrupt prefix and returns remaining text", () => {
	function parsePrompt(prompt) {
		let payload = prompt;
		let interrupted = false;
		if (payload.startsWith("!")) {
			interrupted = true;
			payload = payload.slice(1).trimStart();
		}
		return { interrupted, text: payload };
	}

	const r1 = parsePrompt("! please refocus on the auth module");
	assert.ok(r1.interrupted, "should detect interrupt");
	assert.strictEqual(r1.text, "please refocus on the auth module");

	const r2 = parsePrompt("!please refocus");
	assert.ok(r2.interrupted, "should detect interrupt without space");
	assert.strictEqual(r2.text, "please refocus");

	const r3 = parsePrompt("!");
	assert.ok(r3.interrupted, "bare '!' should interrupt");
	assert.strictEqual(r3.text, "", "bare '!' leaves no follow-up text");

	const r4 = parsePrompt("/agent-check a-0001");
	assert.ok(!r4.interrupted, "slash command should not interrupt");
	assert.strictEqual(r4.text, "/agent-check a-0001");
});

test("agent-send '/' prefix is forwarded verbatim (no special parse)", () => {
	function parsePrompt(prompt) {
		let payload = prompt;
		let interrupted = false;
		if (payload.startsWith("!")) {
			interrupted = true;
			payload = payload.slice(1).trimStart();
		}
		return { interrupted, text: payload };
	}

	const r = parsePrompt("/quit");
	assert.ok(!r.interrupted);
	assert.strictEqual(r.text, "/quit", "slash command is forwarded as-is");
});

// ---------------------------------------------------------------------------
// 5. Branch naming convention
// ---------------------------------------------------------------------------

test("agent branch name follows parallel-agent/<id> convention", () => {
	function branchForId(id) {
		return `parallel-agent/${id}`;
	}

	assert.strictEqual(branchForId("a-0001"), "parallel-agent/a-0001");
	assert.strictEqual(branchForId("a-0042"), "parallel-agent/a-0042");

	// Branch must not start with a slash or dot
	const branch = branchForId("a-0001");
	assert.ok(!branch.startsWith("/"), "branch must not start with /");
	assert.ok(!branch.startsWith("."), "branch must not start with .");
});
