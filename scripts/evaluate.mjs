import fs from "node:fs/promises";
import { IntelligentAgentRouter } from "../dist/orchestrator/agent-router.js";

const cases = JSON.parse(await fs.readFile(new URL("../evals/routing-cases.json", import.meta.url), "utf8"));
const router = new IntelligentAgentRouter();
let passed = 0;
const failures = [];

for (const item of cases) {
  const result = await router.route(item.prompt);
  const selectedSkills = result.selectedSkills.map((entry) => entry.candidate.id);
  const modelMatches = result.primaryModel.candidate.id === item.expectedModel;
  const skillsMatch = item.expectedSkills.every((skill) => selectedSkills.includes(skill));
  const verificationMatches = result.analysis.requiresVerification === item.requiresVerification;

  if (modelMatches && skillsMatch && verificationMatches) {
    passed += 1;
  } else {
    failures.push({
      name: item.name,
      expected: {
        model: item.expectedModel,
        skills: item.expectedSkills,
        requiresVerification: item.requiresVerification,
      },
      actual: {
        model: result.primaryModel.candidate.id,
        skills: selectedSkills,
        requiresVerification: result.analysis.requiresVerification,
      },
    });
  }
}

const score = passed / cases.length;
console.log(JSON.stringify({ passed, total: cases.length, score, failures }, null, 2));
if (failures.length > 0) process.exit(1);
