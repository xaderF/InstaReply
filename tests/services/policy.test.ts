import assert from "node:assert/strict";
import test from "node:test";
import { ContactSegment, PrismaClient, ReplyPolicy } from "@prisma/client";
import {
  CONTACT_SEGMENTS,
  ensureAllPolicies,
  ensurePolicy,
  getDefaultPolicy,
  isContactSegment
} from "../../apps/server/src/services/policy";

function createPolicyPrismaMock(
  seeded: Partial<Record<ContactSegment, Partial<ReplyPolicy>>> = {}
): { prisma: PrismaClient; store: Map<ContactSegment, ReplyPolicy> } {
  let counter = 0;
  const store = new Map<ContactSegment, ReplyPolicy>();

  for (const [segment, value] of Object.entries(seeded) as Array<
    [ContactSegment, Partial<ReplyPolicy>]
  >) {
    const now = new Date();
    store.set(segment, {
      id: `policy_seed_${++counter}`,
      segment,
      autoSend: value.autoSend ?? false,
      requireHumanApproval: value.requireHumanApproval ?? true,
      template: value.template ?? null,
      createdAt: now,
      updatedAt: now
    });
  }

  const prisma = {
    replyPolicy: {
      upsert: async ({
        where,
        create
      }: {
        where: { segment: ContactSegment };
        create: {
          segment: ContactSegment;
          autoSend: boolean;
          requireHumanApproval: boolean;
          template: string | null;
        };
      }): Promise<ReplyPolicy> => {
        const existing = store.get(where.segment);
        if (existing) {
          return existing;
        }

        const now = new Date();
        const created: ReplyPolicy = {
          id: `policy_${++counter}`,
          segment: create.segment,
          autoSend: create.autoSend,
          requireHumanApproval: create.requireHumanApproval,
          template: create.template,
          createdAt: now,
          updatedAt: now
        };
        store.set(where.segment, created);
        return created;
      }
    }
  };

  return { prisma: prisma as unknown as PrismaClient, store };
}

test("isContactSegment accepts known enum values and rejects invalid input", () => {
  assert.equal(isContactSegment("FRIEND"), true);
  assert.equal(isContactSegment("KNOWN"), true);
  assert.equal(isContactSegment("STRANGER"), true);
  assert.equal(isContactSegment("VIP"), true);
  assert.equal(isContactSegment("NOT_A_SEGMENT"), false);
});

test("getDefaultPolicy returns expected defaults", () => {
  const stranger = getDefaultPolicy(ContactSegment.STRANGER);
  const friend = getDefaultPolicy(ContactSegment.FRIEND);

  assert.equal(stranger.autoSend, true);
  assert.equal(stranger.requireHumanApproval, false);
  assert.equal(friend.autoSend, false);
  assert.equal(friend.requireHumanApproval, true);
});

test("ensurePolicy creates defaults when policy does not exist", async () => {
  const { prisma, store } = createPolicyPrismaMock();

  const policy = await ensurePolicy(prisma, ContactSegment.VIP);

  assert.equal(policy.segment, ContactSegment.VIP);
  assert.equal(policy.autoSend, false);
  assert.equal(policy.requireHumanApproval, true);
  assert.equal(store.size, 1);
});

test("ensureAllPolicies returns all segments in fixed display order", async () => {
  const { prisma } = createPolicyPrismaMock({
    STRANGER: {
      autoSend: false,
      requireHumanApproval: true,
      template: "Custom stranger policy"
    }
  });

  const policies = await ensureAllPolicies(prisma);

  assert.equal(policies.length, CONTACT_SEGMENTS.length);
  assert.deepEqual(
    policies.map((policy) => policy.segment),
    CONTACT_SEGMENTS
  );

  const stranger = policies.find((policy) => policy.segment === ContactSegment.STRANGER);
  assert.ok(stranger);
  assert.equal(stranger.autoSend, false);
  assert.equal(stranger.requireHumanApproval, true);
  assert.equal(stranger.template, "Custom stranger policy");
});
