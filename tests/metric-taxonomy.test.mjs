import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCanonicalMetricTaxonomy,
  getMetricDefinition,
  verifyMetricTaxonomy,
} from "../dist/index.js";

test("canonical M4 metric taxonomy is deterministic, content-addressed, and preserves metric semantics", async () => {
  const first = await buildCanonicalMetricTaxonomy();
  const second = await buildCanonicalMetricTaxonomy();
  assert.deepEqual(second, first);
  await verifyMetricTaxonomy(first);
  assert.equal(first.payload.definitions.length, 8);
  assert.deepEqual(getMetricDefinition(first, "execution.latency_ms"), {
    id: "execution.latency_ms",
    domain: "efficiency",
    unit: "milliseconds",
    direction: "lower_is_better",
    sourceOwner: "run_ledger_projection",
    availability: "optional",
  });
  assert.equal(getMetricDefinition(first, "eval.critical_pass_rate").direction, "higher_is_better");
});

test("metric taxonomy rejects semantic drift even when a caller recomputes envelope fields incompletely", async () => {
  const taxonomy = await buildCanonicalMetricTaxonomy();
  const tampered = {
    ...taxonomy,
    payload: {
      ...taxonomy.payload,
      definitions: taxonomy.payload.definitions.map((item) => item.id === "execution.cost_usd" ? { ...item, direction: "higher_is_better" } : item),
    },
  };
  await assert.rejects(() => verifyMetricTaxonomy(tampered), /differs from canonical M4 taxonomy|digest does not match/);

  const reordered = {
    ...taxonomy,
    payload: { ...taxonomy.payload, definitions: [...taxonomy.payload.definitions].reverse() },
  };
  await assert.rejects(() => verifyMetricTaxonomy(reordered), /order is not canonical|differs from canonical/);
});
