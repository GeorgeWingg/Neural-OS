import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildSkillsPromptMetadata,
	buildSkillsStatus,
	filterEligibleSkills,
	loadSkillEntries,
} from "../services/skillsFilesystemRuntime.mjs";

const tempRoots = [];

async function makeTempRoot() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "neural-computer-skills-"));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(
		tempRoots.splice(0, tempRoots.length).map(async (root) => {
			await fs.rm(root, { recursive: true, force: true });
		}),
	);
});

async function writeSkill(root, folderName, frontmatter, body = "Skill body") {
	const skillDir = path.join(root, folderName);
	await fs.mkdir(skillDir, { recursive: true });
	const filePath = path.join(skillDir, "SKILL.md");
	await fs.writeFile(filePath, `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
	return filePath;
}

describe("skills filesystem runtime", () => {
	it("loads skills from workspace and extra directories", async () => {
		const workspaceRoot = await makeTempRoot();
		const extraRoot = await makeTempRoot();
		await writeSkill(path.join(workspaceRoot, "skills"), "onboarding", "name: onboarding_skill\ndescription: Helps onboarding");
		await writeSkill(extraRoot, "memory-helper", "name: memory_helper\ndescription: Memory helper");

		const entries = await loadSkillEntries({
			workspaceRoot,
			extraSkillDirs: [extraRoot],
		});

		expect(entries.map((entry) => entry.id)).toEqual(["onboarding_skill", "memory_helper"]);
	});

	it("marks skills blocked when required env keys are missing", async () => {
		const workspaceRoot = await makeTempRoot();
		await writeSkill(path.join(workspaceRoot, "skills"), "onboarding", "name: onboarding_skill\nrequired_env: OPENAI_API_KEY");
		const entries = await loadSkillEntries({ workspaceRoot });

		const report = await filterEligibleSkills(entries, {});
		expect(report.eligibleSkills).toHaveLength(0);
		expect(report.blockedSkills).toHaveLength(1);
		expect(report.blockedSkills[0].blockedBy.missingEnv).toEqual(["OPENAI_API_KEY"]);
	});

	it("builds readable metadata prompt for eligible skills", async () => {
		const workspaceRoot = await makeTempRoot();
		await writeSkill(path.join(workspaceRoot, "skills"), "onboarding", "name: onboarding_skill\ndescription: Dynamic onboarding");
		const status = await buildSkillsStatus({ workspaceRoot, env: process.env });
		const metadata = buildSkillsPromptMetadata(status);
		expect(metadata).toContain("Filesystem Skills");
		expect(metadata).toContain("onboarding_skill");
		expect(metadata).toContain("read tool");
	});
});
