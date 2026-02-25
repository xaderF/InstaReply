import { ConnectionStatus, InstagramConnection, PrismaClient } from "@prisma/client";

export async function getOrCreateInstagramConnection(
  prisma: PrismaClient
): Promise<InstagramConnection> {
  const existing = await prisma.instagramConnection.findFirst({
    orderBy: { createdAt: "asc" }
  });

  if (existing) return existing;

  return prisma.instagramConnection.create({
    data: {
      status: ConnectionStatus.DISCONNECTED
    }
  });
}

export async function upsertConnectedInstagramConnection(
  prisma: PrismaClient,
  input: {
    accessToken: string;
    igBusinessAccountId: string;
    pageId?: string | null;
    pageName?: string | null;
    scope?: string | null;
    tokenType?: string | null;
  }
): Promise<InstagramConnection> {
  const record = await getOrCreateInstagramConnection(prisma);

  return prisma.instagramConnection.update({
    where: { id: record.id },
    data: {
      status: ConnectionStatus.CONNECTED,
      accessToken: input.accessToken,
      igBusinessAccountId: input.igBusinessAccountId,
      pageId: input.pageId ?? null,
      pageName: input.pageName ?? null,
      scope: input.scope ?? null,
      tokenType: input.tokenType ?? null,
      connectedAt: new Date(),
      lastError: null
    }
  });
}

export async function markInstagramConnectionError(
  prisma: PrismaClient,
  message: string
): Promise<InstagramConnection> {
  const record = await getOrCreateInstagramConnection(prisma);

  return prisma.instagramConnection.update({
    where: { id: record.id },
    data: {
      status: ConnectionStatus.ERROR,
      lastError: message
    }
  });
}

export async function disconnectInstagramConnection(
  prisma: PrismaClient
): Promise<InstagramConnection> {
  const record = await getOrCreateInstagramConnection(prisma);

  return prisma.instagramConnection.update({
    where: { id: record.id },
    data: {
      status: ConnectionStatus.DISCONNECTED,
      accessToken: null,
      igBusinessAccountId: null,
      pageId: null,
      pageName: null,
      tokenType: null,
      scope: null,
      lastError: null,
      connectedAt: null
    }
  });
}
