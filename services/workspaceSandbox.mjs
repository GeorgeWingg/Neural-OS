import fs from "node:fs";
import path from "node:path";

const WORKSPACE_POLICY_ERROR_NAME = "WorkspacePolicyError";

export class WorkspacePolicyError extends Error {
	constructor(code, message, details = undefined) {
		super(message);
		this.name = WORKSPACE_POLICY_ERROR_NAME;
		this.code = code;
		this.details = details;
	}
}

function cleanPathInput(value) {
	if (typeof value !== "string") return "";
	return value.trim();
}

function normalizePath(value) {
	return path.resolve(value);
}

export function isPathInsideWorkspace(candidatePath, workspaceRoot) {
	const candidate = normalizePath(candidatePath);
	const root = normalizePath(workspaceRoot);
	if (candidate === root) return true;
	return candidate.startsWith(`${root}${path.sep}`);
}

function assertWorkspacePathText(value, label) {
	if (!value) {
		throw new WorkspacePolicyError(
			"WORKSPACE_PATH_REQUIRED",
			`${label} is required.`,
		);
	}
	if (value.includes("\0")) {
		throw new WorkspacePolicyError(
			"WORKSPACE_PATH_INVALID",
			`${label} contains a null byte.`,
		);
	}
}

function normalizeRelativeWorkspacePath(inputPath, label, allowDot = false) {
	const raw = cleanPathInput(inputPath);
	assertWorkspacePathText(raw, label);
	if (path.isAbsolute(raw)) {
		throw new WorkspacePolicyError(
			"WORKSPACE_PATH_ABSOLUTE_BLOCKED",
			`${label} must be relative to the configured workspace root.`,
			{ inputPath: raw },
		);
	}
	const normalized = path.normalize(raw);
	if (!allowDot && (normalized === "." || normalized === "")) {
		throw new WorkspacePolicyError(
			"WORKSPACE_PATH_INVALID",
			`${label} must point to a file or directory inside the workspace.`,
			{ inputPath: raw },
		);
	}
	if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
		throw new WorkspacePolicyError(
			"WORKSPACE_PATH_ESCAPE_BLOCKED",
			`${label} escapes the workspace root.`,
			{ inputPath: raw },
		);
	}
	return normalized;
}

function formatBlockedPathMessage(targetPath, workspaceRoot) {
	return `Path '${targetPath}' is outside workspace root '${workspaceRoot}'.`;
}

function assertPathInsideWorkspaceOrThrow(targetPath, workspaceRoot, details = undefined) {
	if (isPathInsideWorkspace(targetPath, workspaceRoot)) return;
	throw new WorkspacePolicyError(
		"WORKSPACE_PATH_ESCAPE_BLOCKED",
		formatBlockedPathMessage(targetPath, workspaceRoot),
		details,
	);
}

async function resolveExistingPathRealpath(targetPath) {
	try {
		return await fs.promises.realpath(targetPath);
	} catch (error) {
		if (error && error.code === "ENOENT") return null;
		throw error;
	}
}

function normalizePolicyRoots(allowedRoots) {
	if (!Array.isArray(allowedRoots)) return [];
	return allowedRoots
		.map((entry) => cleanPathInput(entry))
		.filter(Boolean)
		.map((entry) => normalizePath(entry));
}

export function createWorkspacePolicy(config = {}) {
	const defaultWorkspaceRootInput = cleanPathInput(config.defaultWorkspaceRoot) || "./workspace";
	return {
		defaultWorkspaceRoot: defaultWorkspaceRootInput,
		allowedRoots: normalizePolicyRoots(config.allowedRoots),
	};
}

async function materializeAllowedRoots(policy) {
	const allowedRoots = Array.isArray(policy?.allowedRoots) ? policy.allowedRoots : [];
	const resolvedRoots = [];
	for (const allowedRoot of allowedRoots) {
		const absolute = normalizePath(allowedRoot);
		const real = await resolveExistingPathRealpath(absolute);
		resolvedRoots.push(real || absolute);
	}
	return resolvedRoots;
}

export async function resolveWorkspaceRoot({
	requestedWorkspaceRoot,
	policy,
}) {
	const policyConfig = policy || createWorkspacePolicy();
	const configuredRoot =
		cleanPathInput(requestedWorkspaceRoot) || cleanPathInput(policyConfig.defaultWorkspaceRoot);

	if (!configuredRoot) {
		throw new WorkspacePolicyError(
			"WORKSPACE_ROOT_REQUIRED",
			"workspaceRoot must be configured before running workspace tools.",
		);
	}

	const absoluteConfiguredRoot = normalizePath(configuredRoot);
	await fs.promises.mkdir(absoluteConfiguredRoot, { recursive: true });
	const canonicalWorkspaceRoot = await fs.promises.realpath(absoluteConfiguredRoot);

	const allowedRoots = await materializeAllowedRoots(policyConfig);
	if (allowedRoots.length > 0) {
		const allowed = allowedRoots.some((allowedRoot) => isPathInsideWorkspace(canonicalWorkspaceRoot, allowedRoot));
		if (!allowed) {
			throw new WorkspacePolicyError(
				"WORKSPACE_ROOT_OUT_OF_POLICY",
				`workspaceRoot '${canonicalWorkspaceRoot}' is outside allowed policy roots.`,
				{
					requestedWorkspaceRoot: configuredRoot,
					canonicalWorkspaceRoot,
					allowedRoots,
				},
			);
		}
	}

	return {
		configuredWorkspaceRoot: configuredRoot,
		canonicalWorkspaceRoot,
	};
}

export async function resolveWorkspacePathForRead(canonicalWorkspaceRoot, inputPath, options = {}) {
	const normalizedRelativePath = normalizeRelativeWorkspacePath(inputPath || ".", "path", true);
	const rawTargetPath = normalizePath(path.join(canonicalWorkspaceRoot, normalizedRelativePath));
	assertPathInsideWorkspaceOrThrow(rawTargetPath, canonicalWorkspaceRoot, {
		inputPath,
		resolvedPath: rawTargetPath,
	});

	const canonicalTargetPath = await resolveExistingPathRealpath(rawTargetPath);
	if (!canonicalTargetPath) {
		throw new WorkspacePolicyError(
			"WORKSPACE_PATH_NOT_FOUND",
			`Path '${inputPath}' does not exist in workspace.`,
			{
				inputPath,
			},
		);
	}
	assertPathInsideWorkspaceOrThrow(canonicalTargetPath, canonicalWorkspaceRoot, {
		inputPath,
		resolvedPath: canonicalTargetPath,
	});

	const stats = await fs.promises.stat(canonicalTargetPath);
	const allowFile = options.allowFile !== false;
	const allowDirectory = Boolean(options.allowDirectory);
	if (stats.isDirectory() && !allowDirectory) {
		throw new WorkspacePolicyError(
			"WORKSPACE_PATH_EXPECTED_FILE",
			`Path '${inputPath}' is a directory; expected a file.`,
		);
	}
	if (stats.isFile() && !allowFile) {
		throw new WorkspacePolicyError(
			"WORKSPACE_PATH_EXPECTED_DIRECTORY",
			`Path '${inputPath}' is a file; expected a directory.`,
		);
	}

	return {
		canonicalPath: canonicalTargetPath,
		relativePath: path.relative(canonicalWorkspaceRoot, canonicalTargetPath) || ".",
		stats,
	};
}

export async function resolveWorkspacePathForWrite(canonicalWorkspaceRoot, inputPath, options = {}) {
	const normalizedRelativePath = normalizeRelativeWorkspacePath(inputPath, "path", false);
	const targetPath = normalizePath(path.join(canonicalWorkspaceRoot, normalizedRelativePath));
	assertPathInsideWorkspaceOrThrow(targetPath, canonicalWorkspaceRoot, {
		inputPath,
		resolvedPath: targetPath,
	});

	const parentPath = path.dirname(targetPath);
	if (options.ensureParentDir !== false) {
		await fs.promises.mkdir(parentPath, { recursive: true });
	}
	const canonicalParent = await fs.promises.realpath(parentPath);
	assertPathInsideWorkspaceOrThrow(canonicalParent, canonicalWorkspaceRoot, {
		inputPath,
		parentPath: canonicalParent,
	});

	const existingCanonicalPath = await resolveExistingPathRealpath(targetPath);
	if (existingCanonicalPath) {
		assertPathInsideWorkspaceOrThrow(existingCanonicalPath, canonicalWorkspaceRoot, {
			inputPath,
			resolvedPath: existingCanonicalPath,
		});
	}

	return {
		canonicalPath: existingCanonicalPath || targetPath,
		relativePath: path.relative(canonicalWorkspaceRoot, existingCanonicalPath || targetPath) || ".",
	};
}

export function toPolicyErrorPayload(error) {
	if (!(error instanceof WorkspacePolicyError)) return null;
	return {
		code: error.code || "WORKSPACE_POLICY_ERROR",
		message: error.message,
		details: error.details,
	};
}
