import { Injectable } from '@nestjs/common';
import { simpleParser, type AddressObject } from 'mailparser';
import { readableEmailBody } from './email-body';

export type NormalizedEmail = {
  providerMessageId: string;
  rfcMessageId: string | null;
  threadId: string;
  direction: 'inbound' | 'outbound' | 'internal';
  fromJson: Array<{ name: string; address: string | null }>;
  toJson: Array<{ name: string; address: string | null }>;
  ccJson: Array<{ name: string; address: string | null }>;
  bccJson: Array<{ name: string; address: string | null }>;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  headersJson: { inReplyTo: string | null; references: string[] };
  rawSource: Uint8Array<ArrayBuffer>;
  sentAt: Date | null;
  receivedAt: Date | null;
};

@Injectable()
export class EmailNormalizer {
  async normalize(input: {
    mailbox: string;
    uidValidity: bigint;
    uid: number;
    rawSource: Buffer;
    receivedAt: Date | null;
    accountEmail: string;
  }): Promise<NormalizedEmail> {
    const parsed = await simpleParser(input.rawSource);
    const from = this.addresses(parsed.from);
    const references = Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : [];
    const messageId = parsed.messageId?.trim() || null;
    const threadId =
      references[0] ?? parsed.inReplyTo?.trim() ?? messageId ??
      `imap:${encodeURIComponent(input.mailbox)}:${input.uidValidity}:${input.uid}`;
    const senderIsMailbox = from.some(
      (address) => address.address?.toLowerCase() === input.accountEmail.toLowerCase(),
    );
    const recipientIsMailbox = this.addresses(parsed.to).some(
      (address) => address.address?.toLowerCase() === input.accountEmail.toLowerCase(),
    );
    const direction = senderIsMailbox && recipientIsMailbox
      ? 'internal'
      : senderIsMailbox
        ? 'outbound'
        : 'inbound';

    return {
      providerMessageId: `imap:${encodeURIComponent(input.mailbox)}:${input.uidValidity}:${input.uid}`,
      rfcMessageId: messageId,
      threadId,
      direction,
      fromJson: from,
      toJson: this.addresses(parsed.to),
      ccJson: this.addresses(parsed.cc),
      bccJson: this.addresses(parsed.bcc),
      subject: parsed.subject ?? null,
      bodyText: readableEmailBody(parsed.text, typeof parsed.html === 'string' ? parsed.html : null),
      bodyHtml: typeof parsed.html === 'string' ? parsed.html : null,
      headersJson: {
        inReplyTo: parsed.inReplyTo ?? null,
        references,
      },
      rawSource: new Uint8Array(input.rawSource),
      sentAt: parsed.date ?? null,
      receivedAt: input.receivedAt,
    };
  }

  private addresses(value: AddressObject | AddressObject[] | undefined) {
    const objects = value ? (Array.isArray(value) ? value : [value]) : [];
    return objects.flatMap((object) =>
      object.value.map((address) => ({
        name: address.name,
        address: address.address ?? null,
      })),
    );
  }
}
