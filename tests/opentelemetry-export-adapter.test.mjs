import test from "node:test";
import assert from "node:assert/strict";
import { InternalObservabilityEventBuilder, OpenTelemetryExportAdapter, toOpenTelemetryExportRequest } from "../dist/index.js";

const NOW = "2026-08-18T04:45:00.000Z";
function eventBuilder() { return new InternalObservabilityEventBuilder({ maxEventBytes: 32 * 1024, maxAttributes: 32, maxLinks: 16, maxStringBytes: 2048 }); }
async function sampleEvent() { return eventBuilder().create({ name: "9router.verification.completed", occurredAt: NOW, severity: "info", traceId: "trace-otel-1", runId: "run-otel-1", projectId: "project-1", attributes: { "router.verification.passed": true, "router.verifier.id": "deterministic-verifier" }, links: [{ type: "runtime_session", reference: "runtime:opencode:ses-1" }] }); }

test("OpenTelemetry adapter maps one verified internal event to Resource + INTERNAL Span", async () => {
  const event = await sampleEvent(); const calls = [];
  const adapter = new OpenTelemetryExportAdapter({ async export(request) { calls.push(request); return { reference: "otel:span:1" }; } }, { serviceName: "9router", instrumentationScopeVersion: "1.0.0", maxExportBytes: 64 * 1024, now: () => NOW });
  const receipt = await adapter.export(event); assert.equal(calls.length, 1); const request = calls[0];
  assert.equal(request.resource.attributes["service.name"], "9router"); assert.equal(request.instrumentationScope.name, "9router.observability"); assert.equal(request.spans.length, 1); assert.equal(request.spans[0].kind, "INTERNAL"); assert.equal(request.spans[0].status.code, "OK"); assert.equal(request.spans[0].attributes["router.trace.id"], "trace-otel-1"); assert.equal(request.spans[0].attributes["router.event.id"], event.eventId); assert.equal(request.spans[0].attributes["router.run.id"], "run-otel-1"); assert.equal(request.spans[0].attributes["router.project.id"], "project-1");
  assert.deepEqual(request.spans[0].events, [{ name: "9router.reference", time: NOW, attributes: { "router.link.type": "runtime_session", "router.link.reference": "runtime:opencode:ses-1" } }]);
  assert.equal(receipt.reference, "otel:span:1"); assert.equal(receipt.eventId, event.eventId); const serialized = JSON.stringify(request); assert.doesNotMatch(serialized, /gen_ai\./); assert.doesNotMatch(serialized, /"otel\./);
});

test("OpenTelemetry mapping keeps 9Router trace identity as correlation metadata instead of pretending it is an OTel trace id", async () => {
  const event = await sampleEvent(); const request = toOpenTelemetryExportRequest(event, { serviceName: "9router", instrumentationScopeName: "9router.test", instrumentationScopeVersion: "1" });
  assert.equal(request.instrumentationScope.name, "9router.test"); assert.equal(request.spans[0].attributes["router.trace.id"], "trace-otel-1"); assert.equal("traceId" in request.spans[0], false); assert.equal("spanId" in request.spans[0], false);
});

test("OpenTelemetry adapter rejects tampered events before exporter side effects", async () => {
  const event = await sampleEvent(); let calls = 0;
  const adapter = new OpenTelemetryExportAdapter({ async export() { calls += 1; return {}; } }, { serviceName: "9router", instrumentationScopeVersion: "1", maxExportBytes: 64 * 1024 });
  await assert.rejects(() => adapter.export({ ...event, eventId: "obs:00000000000000000000000000000000" }), /eventId does not match/); assert.equal(calls, 0);
});

test("OpenTelemetry adapter performs no automatic retry when export fails", async () => {
  const event = await sampleEvent(); let calls = 0;
  const adapter = new OpenTelemetryExportAdapter({ async export() { calls += 1; throw new Error("collector unavailable"); } }, { serviceName: "9router", instrumentationScopeVersion: "1", maxExportBytes: 64 * 1024 });
  await assert.rejects(() => adapter.export(event), /collector unavailable/); assert.equal(calls, 1);
});

test("OpenTelemetry adapter enforces export byte bounds before client call", async () => {
  const event = await sampleEvent(); let calls = 0;
  const adapter = new OpenTelemetryExportAdapter({ async export() { calls += 1; return {}; } }, { serviceName: "9router", instrumentationScopeVersion: "1", maxExportBytes: 64 });
  await assert.rejects(() => adapter.export(event), /exceeds maxExportBytes/); assert.equal(calls, 0);
});
