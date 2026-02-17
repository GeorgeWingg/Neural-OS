import fs from "node:fs/promises";
import path from "node:path";

function normalizeText(value) {
	if (typeof value === "string") return value.trim();
	if (value === null || value === undefined) return "";
	return String(value).trim();
}

function parseCommaList(value) {
	const source = normalizeText(value);
	if (!source) return [];
	return source
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

async function hasBinary(binName, env = process.env) {
	const source = normalizeText(binName);
	if (!source) return false;
	const pathEntries = String(env?.PATH || "")
		.split(path.delimiter)
		.map((entry) => entry.trim())
		.filter(Boolean);
	for (const entry of pathEntries) {
		const candidate = path.join(entry, source);
		try {
			// eslint-disable-next-line no-await-in-loop
			await fs.access(candidate);
			return true;
		} catch {
			// Continue searching.
		}
	}
	return false;
}

function parseFrontmatter(markdown) {
	const source = typeof markdown === "string" ? markdown : "";
	if (!source.startsWith("---\n")) {
		return { attributes: {}, body: source };
	}
	const end = source.indexOf("\n---\n", 4);
	if (end < 0) {
		return { attributes: {}, body: source };
	}
	const frontmatter = source.slice(4, end);
	const body = source.slice(end + 5);
	const attributes = {};
	for (const line of frontmatter.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const sep = trimmed.indexOf(":");
		if (sep < 0) continue;
		const key = trimmed.slice(0, sep).trim();
		let value = trimmed.slice(sep + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		attributes[key] = value;
	}
	return { attributes, body };
}

async function listDirectorySafe(directoryPath) {
	try {
		return await fs.readdir(directoryPath, { withFileTypes: true });
	} catch {
		return [];
	}
}

async function loadSkillFromPath(skillPath, source) {
	const raw = await fs.readFile(skillPath, "utf8");
	const parsed = parseFrontmatter(raw);
	const directory = path.dirname(skillPath);
	const defaultId = path.basename(directory);
	const id = normalizeText(parsed.attributes.name) || defaultId;
	const title = normalizeText(parsed.attributes.title) || id;
	const description = normalizeText(parsed.attributes.description);
	const requiredBins = parseCommaList(parsed.attributes.required_bins || parsed.attributes.bins);
	const requiredEnv = parseCommaList(parsed.attributes.required_env || parsed.attributes.env_keys);
	return {
		id,
		title,
		description,
		path: skillPath,
		directory,
		source,
		requiredBins,
		requiredEnv,
		attributes: parsed.attributes,
		body: parsed.body,
	};
}

function uniqueById(entries) {
	const seen = new Set();
	const output = [];
	for (const entry of entries) {
		const key = entry.id.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(entry);
	}
	return output;
}

export async function loadSkillEntries({
	workspaceRoot,
	bundledSkillDirs = [],
	extraSkillDirs = [],
	homeSkillDir,
} = {}) {
	const workspaceSkillsDir = path.join(path.resolve(workspaceRoot || "."), "skills");
	const candidateRoots = [
		workspaceSkillsDir,
		...(Array.isArray(extraSkillDirs) ? extraSkillDirs : []),
		homeSkillDir,
		...(Array.isArray(bundledSkillDirs) ? bundledSkillDirs : []),
	]
		.map((entry) => normalizeText(entry))
		.filter(Boolean)
		.map((entry) => path.resolve(entry));

	const discovered = [];
	for (const root of candidateRoots) {
		const items = await listDirectorySafe(root);
		for (const item of items) {
			const itemPath = path.join(root, item.name);
			if (item.isDirectory()) {
				const nestedSkillPath = path.join(itemPath, "SKILL.md");
				try {
					// eslint-disable-next-line no-await-in-loop
					await fs.access(nestedSkillPath);
					// eslint-disable-next-line no-await-in-loop
					discovered.push(await loadSkillFromPath(nestedSkillPath, root));
				} catch {
					// Ignore non-skill directory.
				}
				continue;
			}
			if (item.isFile() && item.name === "SKILL.md") {
				// eslint-disable-next-line no-await-in-loop
				discovered.push(await loadSkillFromPath(itemPath, root));
			}
		}
	}
	return uniqueById(discovered);
}

export async function filterEligibleSkills(entries, env = process.env) {
	const eligibleSkills = [];
	const blockedSkills = [];

	for (const entry of Array.isArray(entries) ? entries : []) {
		const missingEnv = entry.requiredEnv.filter((key) => !normalizeText(env?.[key]));
		const missingBins = [];
		for (const bin of entry.requiredBins) {
			// eslint-disable-next-line no-await-in-loop
			const exists = await hasBinary(bin, env);
			if (!exists) missingBins.push(bin);
		}
		if (missingEnv.length || missingBins.length) {
			blockedSkills.push({
				...entry,
				blockedBy: {
					missingEnv,
					missingBins,
				},
			});
			continue;
		}
		eligibleSkills.push(entry);
	}

	return {
		eligibleSkills,
		blockedSkills,
	};
}

export function buildSkillsPromptMetadata(report, options = {}) {
	const maxSkills = Number.isFinite(options.maxSkills) ? Math.max(1, Math.floor(options.maxSkills)) : 32;
	const eligible = Array.isArray(report?.eligibleSkills) ? report.eligibleSkills.slice(0, maxSkills) : [];
	if (!eligible.length) {
		return [
			"Filesystem Skills:",
			"- No eligible filesystem skills discovered for this workspace.",
			"- Continue safely without skill-specific policy and use tools conservatively.",
		].join("\n");
	}
	const rows = eligible.map((skill, index) => {
		const desc = skill.description ? ` :: ${skill.description}` : "";
		return `${index + 1}. ${skill.id}${desc} (path=${skill.path})`;
	});
	return [
		"Filesystem Skills (metadata only):",
		...rows,
		"",
		"Use the read tool to open the relevant SKILL.md before applying skill-specific instructions.",
	].join("\n");
}

export async function buildSkillsStatus(args = {}) {
	const entries = await loadSkillEntries(args);
	const eligibility = await filterEligibleSkills(entries, args.env || process.env);
	return {
		discovered: entries.length,
		eligible: eligibility.eligibleSkills.length,
		blocked: eligibility.blockedSkills.length,
		...eligibility,
	};
}
