import { ContactSegment, PrismaClient, ReplyPolicy } from "@prisma/client";

type PolicyDefaults = {
  autoSend: boolean;
  requireHumanApproval: boolean;
  template: string | null;
};

const DEFAULT_POLICIES: Record<ContactSegment, PolicyDefaults> = {
  FRIEND: {
    autoSend: false,
    requireHumanApproval: true,
    template: null
  },
  KNOWN: {
    autoSend: true,
    requireHumanApproval: false,
    template: null
  },
  STRANGER: {
    autoSend: true,
    requireHumanApproval: false,
    template: null
  },
  VIP: {
    autoSend: false,
    requireHumanApproval: true,
    template: null
  }
};

export const CONTACT_SEGMENTS: ContactSegment[] = [
  ContactSegment.FRIEND,
  ContactSegment.KNOWN,
  ContactSegment.STRANGER,
  ContactSegment.VIP
];

export function isContactSegment(value: string): value is ContactSegment {
  return CONTACT_SEGMENTS.includes(value as ContactSegment);
}

export function getDefaultPolicy(segment: ContactSegment): PolicyDefaults {
  return DEFAULT_POLICIES[segment];
}

export async function ensurePolicy(
  prisma: PrismaClient,
  segment: ContactSegment
): Promise<ReplyPolicy> {
  const defaults = getDefaultPolicy(segment);
  return prisma.replyPolicy.upsert({
    where: { segment },
    update: {},
    create: {
      segment,
      autoSend: defaults.autoSend,
      requireHumanApproval: defaults.requireHumanApproval,
      template: defaults.template
    }
  });
}

export async function ensureAllPolicies(prisma: PrismaClient): Promise<ReplyPolicy[]> {
  const policies = await Promise.all(
    CONTACT_SEGMENTS.map((segment) => ensurePolicy(prisma, segment))
  );
  return policies.sort(
    (a, b) => CONTACT_SEGMENTS.indexOf(a.segment) - CONTACT_SEGMENTS.indexOf(b.segment)
  );
}
