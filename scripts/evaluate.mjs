import fs from "node:fs/promises";
import {
  IntelligentAgentRouter,
  RoutingEvalPlane,
  prepareEvalBaseline,
  prepareGoldenTaskSuite,
} from "../dist/index.js";

const suiteDefinition = JSON.parse(await fs.readFile(new URL("../evals/golden-routing-v1.json", import.meta.url), "utf8"));
const baselineDefinition = JSON.parse(await fs.readFile(new URL("../evals/baselines/routing-m4-v1.json", import.meta.url), "utf8"));

const suite = await prepareGoldenTaskSuite(suiteDefinition, {
  maxTasks: 64,
  maxAssertionsPerTask: 16,
  maxPromptBytes: 16 * 1024,
  maxStringBytes: 2048,
  maxSuiteBytes: 256 * 1024,
});
const baseline = prepareEvalBaseline(baselineDefinition, 2048);
const router = new IntelligentAgentRouter();
const plane = new RoutingEvalPlane({ maxReportBytes: 512 * 1024, maxSubjectIdBytes: 2048 });
const report = await plane.evaluate(suite, {
  id: "intelligent-agent-router",
  route: (prompt) => router.route(prompt),
});
const comparison = await plane.compare(report, baseline);

const failedTasks = report.payload.tasks
  .filter((task) => !task.passed)
  .map((task) => ({
    taskId: task.taskId,
    score: task.score,
    critical: task.critical,
    failedAssertions: task.assertions.filter((assertion) => !assertion.passed),
  }));

console.log(JSON.stringify({
  suiteId: suite.suiteId,
  suiteSha256: suite.suiteSha256,
  reportId: report.reportId,
  reportSha256: report.reportSha256,
  subjectId: report.payload.subjectId,
  metrics: report.payload.metrics,
  baseline: comparison,
  failedTasks,
}, null, 2));

if (!comparison.passed) process.exit(1);
