#!/usr/bin/env node
/* One-time, bounded backfill of evidence-backed details for already classified machine mail. */
const { join } = require('node:path');

const CLASSIFICATIONS = Object.freeze([
  'DELIVERY_FAILURE', 'DELIVERY_DELAY', 'OUT_OF_OFFICE', 'TICKET_CONFIRMATION',
]);

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let apply = false;
  let batchSize = 25;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--help') help = true;
    else if (args[i] === '--batch-size' && /^\d+$/.test(args[i + 1] ?? '')) {
      batchSize = Number(args[++i]);
      if (batchSize < 1 || batchSize > 100) throw new Error('INVALID_ARGUMENTS');
    } else throw new Error('INVALID_ARGUMENTS');
  }
  return { apply, batchSize, help };
}

function candidateWhere(afterId, throughId) {
  return {
    direction: 'inbound',
    classification: { in: CLASSIFICATIONS },
    classificationManualOverride: false,
    automationDetails: { equals: {} },
    ...(afterId || throughId ? { id: { ...(afterId ? { gt: afterId } : {}), ...(throughId ? { lte: throughId } : {}) } } : {}),
  };
}

async function backfill(db, extractAutomationDetails, { apply, batchSize }) {
  const counts = { scanned: 0, withFacts: 0, withoutFacts: 0, updated: 0, conflicted: 0, extractionErrors: 0 };
  const newest = await db.emailMessage.findFirst({
    where: candidateWhere(), orderBy: { id: 'desc' }, select: { id: true },
  });
  if (!newest) return counts;

  let afterId;
  while (true) {
    const batch = await db.emailMessage.findMany({
      where: candidateWhere(afterId, newest.id),
      orderBy: { id: 'asc' }, take: batchSize,
      select: { id: true, classification: true, direction: true, subject: true, bodyText: true, rawSource: true, fromJson: true, toJson: true },
    });
    if (!batch.length) break;
    for (const message of batch) {
      counts.scanned++;
      let details;
      try {
        details = extractAutomationDetails({
          rawSource: message.rawSource, bodyText: message.bodyText, direction: message.direction,
          subject: message.subject, fromJson: message.fromJson, toJson: message.toJson,
        }, message.classification);
        if (!details || details.version !== 1 || details.classification !== message.classification || !Array.isArray(details.facts)) {
          throw new Error('INVALID_EXTRACTION');
        }
      } catch {
        counts.extractionErrors++;
        continue;
      }
      if (details.facts.length) counts.withFacts++;
      else counts.withoutFacts++;
      if (apply) {
        const written = await db.emailMessage.updateMany({
          where: {
            id: message.id, direction: 'inbound', classification: message.classification,
            classificationManualOverride: false, automationDetails: { equals: {} },
          },
          data: { automationDetails: details },
        });
        counts.updated += written.count;
        if (!written.count) counts.conflicted++;
      }
    }
    afterId = batch.at(-1).id;
  }
  return counts;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/backfill-automation-details.cjs [--batch-size 1..100] [--apply]\nDefault is dry-run. --apply fills empty automationDetails for stored inbound machine mail.\n');
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  const { PrismaClient } = require('@prisma/client');
  const { extractAutomationDetails } = require(join(__dirname, '..', 'dist/modules/mail/business-gate.rules.js'));
  const db = new PrismaClient();
  try {
    const counts = await backfill(db, extractAutomationDetails, options);
    process.stdout.write(`${JSON.stringify(counts)}\n`);
    if (counts.extractionErrors) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error && /^(INVALID_ARGUMENTS|DATABASE_URL_REQUIRED)$/.test(error.message) ? error.message : 'BACKFILL_FAILED'}\n`);
    process.exitCode = 1;
  });
}

module.exports = { CLASSIFICATIONS, parseArgs, candidateWhere, backfill };
