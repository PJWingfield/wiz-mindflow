#!/usr/bin/env node
'use strict';
// Operator tool: remove abandoned attachment uploads. Not served over HTTP.
//   node scripts/sweep-attachments.js [--older-than-hours 24] [--limit 50]
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and WIZ_ATTACHMENT_BUCKET in the environment. Prints counts only.
const { loadConfig } = require('../lib/config');
const { createPostgrestRpc } = require('../lib/rpc');
const { createCareerStore } = require('../lib/career-store');
const { createAttachments, createSupabaseStorageTransport } = require('../lib/attachments');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > -1 ? Number(process.argv[i + 1]) : def; };

(async () => {
  const config = loadConfig(process.env);
  if (!config.supabase.url || !config.supabase.serviceKey || !config.storage || !config.storage.bucket) {
    console.error('Supabase URL, service key and WIZ_ATTACHMENT_BUCKET are required.');
    process.exit(2);
  }
  const rpc = createPostgrestRpc({ url: config.supabase.url, serviceKey: config.supabase.serviceKey });
  const store = createCareerStore(rpc);
  const transport = createSupabaseStorageTransport({ url: config.storage.url, serviceKey: config.storage.serviceKey, bucket: config.storage.bucket });
  const attachments = createAttachments({ store, transport, logger: () => {} });
  const result = await attachments.sweepAbandoned({ olderThanSeconds: Math.round(arg('--older-than-hours', 24) * 3600), limit: arg('--limit', 50) });
  console.log(JSON.stringify(result));
  process.exit(result.failed ? 1 : 0);
})().catch(err => { console.error('Sweep failed:', err && err.message); process.exit(1); });
