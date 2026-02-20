export interface MetaWebhookPayload {
  object?: string;
  entry?: MetaEntry[];
}

export interface MetaEntry {
  id?: string;
  time?: number;
  messaging?: MetaMessagingEvent[];
}

export interface MetaMessagingEvent {
  sender?: {
    id?: string;
  };
  recipient?: {
    id?: string;
  };
  timestamp?: number;
  conversation?: {
    id?: string;
  };
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
  };
}

export interface ParsedWebhookJob {
  messageId: string;
  senderId: string;
  text: string;
  timestamp: number;
  threadId: string;
  isFromSelfOrSystem: boolean;
  rawPayload: MetaWebhookPayload;
}
