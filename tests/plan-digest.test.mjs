import test from "node:test";
import assert from "node:assert/strict";
import {canonicalPlanDigest} from "../scripts/lib/plan-digest.mjs";

test("digest canonico ignora ordem de chaves e muda com conteudo do plano", () => {
  const first = {generated_at: "2026-07-27T00:00:00Z", items: [{number: 1, proposed: {Priority: "P1"}}]};
  const reordered = {items: [{proposed: {Priority: "P1"}, number: 1}], generated_at: "2026-07-27T00:00:00Z"};
  const changed = {generated_at: "2026-07-27T00:00:00Z", items: [{number: 1, proposed: {Priority: "P2"}}]};

  assert.equal(canonicalPlanDigest(first), canonicalPlanDigest(reordered));
  assert.notEqual(canonicalPlanDigest(first), canonicalPlanDigest(changed));
});
