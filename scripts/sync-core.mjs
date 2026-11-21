// Syncs shared protocol/wire core modules from upstream:
// https://github.com/ShawTim/gemini-app2api (MIT License, last synced: d3954f2 / v1.5.1)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(pkgRoot, '..', 'gemini-app2api');
const coreRoot = path.join(pkgRoot, 'core');

export const CORE_FILES = [
  'native-wire/consumer-tool-codec.mjs',
  'native-wire/oauth-loopback.mjs',
  'native-wire/protobuf.mjs',
  'native-wire/robin-current.mjs',
  'src/native-provider.mjs',
  'src/openai-contract.mjs',
  'src/openai-usage.mjs',
  'src/prompt-tool-schema.mjs',
  'src/responses-tool-namespaces.mjs',
  'src/tool-protocol.mjs',
  'src/image-input.mjs',
  'src/image-url.mjs',
  'src/gateway/oauth-client-defaults.mjs',
  'src/gateway/automatic-recovery.mjs',
  'src/gateway/image-download.mjs',
  'src/gateway/image-upload.mjs',
  'src/gateway/native-diagnostic.mjs',
  'src/gateway/native-evidence.mjs',
  'src/gateway/native-response-limits.mjs',
  'src/gateway/native-search-citations.mjs',
  'src/gateway/native-search-diagnostic.mjs',
  'src/gateway/native-search-metadata.mjs',
  'src/gateway/native-transport.mjs',
  'src/gateway/output-recovery.mjs',
  'src/gateway/quota-failover.mjs',
  'src/gateway/quota-transport.mjs',
  'src/gateway/quota.mjs',
  'src/gateway/response-delivery.mjs',
  'src/gateway/soft-error.mjs',
  'src/gateway/structured-output.mjs',
  'src/gateway/subscription.mjs',
  'src/gateway/terms.mjs',
];

export const DOC_FILES = ['LICENSE', 'DISCLAIMER.md'];

if (!fs.existsSync(sourceRoot)) {
  throw new Error(`Source repository not found: ${sourceRoot}`);
}

for (const rel of CORE_FILES) {
  const src = path.join(sourceRoot, rel);
  const dst = path.join(coreRoot, rel);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing source file: ${src}`);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

for (const rel of DOC_FILES) {
  const src = path.join(sourceRoot, rel);
  const dst = path.join(pkgRoot, rel);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}

console.log(`Synced ${CORE_FILES.length} core files and ${DOC_FILES.length} root files into ${pkgRoot}`);
