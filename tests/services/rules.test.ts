import assert from "node:assert/strict";
import test from "node:test";
import { KeywordRulesService } from "../../apps/server/src/services/rules";

test("rules classify pricing requests", () => {
  const rules = new KeywordRulesService();
  const draft = rules.generateDraft("How much does this cost?");

  assert.ok(draft);
  assert.equal(draft.intent, "pricing");
  assert.equal(draft.needs_human_approval, false);
});

test("rules classify refund requests", () => {
  const rules = new KeywordRulesService();
  const draft = rules.generateDraft("I need a refund for my purchase");

  assert.ok(draft);
  assert.equal(draft.intent, "refund");
});

test("rules classify shipping requests", () => {
  const rules = new KeywordRulesService();
  const draft = rules.generateDraft("Can you share shipping updates?");

  assert.ok(draft);
  assert.equal(draft.intent, "shipping");
});

test("rules classify order support requests", () => {
  const rules = new KeywordRulesService();
  const draft = rules.generateDraft("My order invoice has an issue");

  assert.ok(draft);
  assert.equal(draft.intent, "order_support");
});

test("rules return null for unknown topics", () => {
  const rules = new KeywordRulesService();
  const draft = rules.generateDraft("Nice weather today.");

  assert.equal(draft, null);
});
