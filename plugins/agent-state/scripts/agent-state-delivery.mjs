// Available-boundary guide delivery. MiniMax appends context; this is not Pi's
// per-provider-call ephemeral message channel or a rich-compaction consumer.
import { join } from 'node:path';
import { RuntimeError, atomicWrite } from './runtime/storage.mjs';
import { hookOutputByteLength, MAX_HOOK_OUTPUT_BYTES } from './runtime/host.mjs';
import { POLICY, SAVE_REMINDER, sha256Hex } from './agent-state-core.mjs';
import { collectGuides, INDEX_FILENAME, MAX_COLLECTED_GUIDES } from './agent-state-store.mjs';

export const MAX_INJECT_BYTES = 80000;
export const MAX_CONTEXT_CHARS = 24000;
export const MAX_INDEX_BYTES = 8 * 1024 * 1024;

export function deliverySettings(env = process.env) {
  const cadence = Number(env.AGENT_STATE_REMIND_EVERY);
  const bytes = Number(env.AGENT_STATE_MAX_INJECT_BYTES);
  return {
    remindEvery: Number.isSafeInteger(cadence) && cadence > 0 ? Math.min(cadence, 100000) : 10,
    maxBytes: Number.isSafeInteger(bytes) && bytes > 0 ? Math.min(bytes, MAX_INJECT_BYTES) : MAX_INJECT_BYTES,
  };
}

const combine = (prefix, body) => prefix && body ? `${prefix}\n\n${body}` : prefix || body;
function safePrefix(text, chars) {
  let end = Math.min(text.length, Math.max(0, chars));
  if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1])) end -= 1;
  return text.slice(0, end);
}
export function utf8Prefix(text, limit) {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, Math.max(0, Math.floor(limit)));
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function prefixWithin(text, maxBytes, predicate) {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const middle = Math.ceil((lo + hi) / 2);
    const prefix = safePrefix(text, middle);
    if (Buffer.byteLength(prefix) <= maxBytes && predicate(prefix)) lo = middle;
    else hi = middle - 1;
  }
  return safePrefix(text, lo);
}

function heading(file) {
  return `\n\nFile ${file.name}${file.title ? `: ${file.title}` : ''} (${file.origin === 'parent' ? 'immediate-parent shared; read-only' : 'own'})\nOriginal: ${file.path}\n`;
}
const pathsOf = (files, issues) => [...new Set([...files.map((file) => file.path), ...issues.map((issue) => issue.path)])];
function directFooter(paths, truncated) {
  if (!paths.length) return '';
  return `\n\n${truncated ? 'INJECTION TRUNCATED. Original guide files are retained.' : 'COLLECTION PARTIAL. Some original locations are unavailable.'}\nRead the complete originals at these paths when needed:\n${paths.map((path) => JSON.stringify(path)).join('\n')}`;
}
function indexFooter(indexPath, truncated) {
  return `\n\n${truncated ? 'INJECTION TRUNCATED. Original guide files are retained.' : 'COLLECTION PARTIAL. Some original locations are unavailable.'}\nThe complete locator list is in this durable index (it contains paths, not summarized guide bodies):\n${indexPath}`;
}

/** Sequential original-text assembly under both actual native limits.
 * The configured lower byte limit caps guide body text. Essential result,
 * policy and complete-locator framing use their reserved native headroom.
 */
export function buildInjection({ files, issues = [], maxBytes = MAX_INJECT_BYTES, preamble = '', prefix = '', event = 'SessionStart', indexPath }) {
  if (!Array.isArray(files) || files.length > MAX_COLLECTED_GUIDES || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !indexPath) {
    throw new RuntimeError('GUIDE_DELIVERY_ARGUMENTS', 'guide delivery limits or locator index are invalid');
  }
  maxBytes = Math.min(maxBytes, MAX_INJECT_BYTES);
  const fits = (body) => {
    const text = combine(prefix, body);
    return text.length <= MAX_CONTEXT_CHARS && hookOutputByteLength(event, text) < MAX_HOOK_OUTPUT_BYTES;
  };
  const issuePaths = pathsOf([], issues);
  let full = preamble;
  let fullBytes = 0;
  let fullFits = true;
  for (const file of files) {
    const part = heading(file) + file.content;
    fullBytes += Buffer.byteLength(file.content);
    if (file.status === 'unavailable' || Buffer.byteLength(file.content) < file.bytes || fullBytes > maxBytes || !fits(full + part)) {
      fullFits = false; break;
    }
    full += part;
  }
  if (fullFits) {
    const footer = directFooter(issuePaths, false);
    if (fits(full + footer)) return { text: combine(prefix, full + footer), truncated: false, omitted: [], indexRequired: false };
    const compactFooter = indexFooter(indexPath, false);
    if (fits(full + compactFooter)) return { text: combine(prefix, full + compactFooter), truncated: false, omitted: [], indexRequired: true };
  }
  const allPaths = pathsOf(files, issues);
  let reservedFooter = directFooter(allPaths, true);
  let indexRequired = !fits(preamble + reservedFooter);
  if (indexRequired) reservedFooter = indexFooter(indexPath, true);
  if (!fits(preamble + reservedFooter)) {
    throw new RuntimeError('GUIDE_DELIVERY_FRAMING_LIMIT', 'essential guide locator framing exceeds native output limits');
  }
  let body = preamble;
  let remainingBytes = maxBytes;
  const omitted = [];
  for (const file of files) {
    const head = heading(file);
    if (file.status === 'unavailable' || !fits(body + head + reservedFooter)) {
      omitted.push(file); continue;
    }
    const content = prefixWithin(file.content, remainingBytes, (part) => fits(body + head + part + reservedFooter));
    if (!content && file.content) { omitted.push(file); continue; }
    body += head + content;
    remainingBytes -= Buffer.byteLength(content);
    if (Buffer.byteLength(content) < file.bytes) omitted.push(file);
  }
  const truncated = omitted.length > 0;
  const footer = indexRequired ? indexFooter(indexPath, truncated) : directFooter(pathsOf(omitted, issues), truncated);
  if (!fits(body + footer)) throw new RuntimeError('GUIDE_DELIVERY_LIMIT', 'assembled guide context exceeds native output limits');
  return { text: combine(prefix, body + footer), truncated, omitted: omitted.map((file) => file.path), indexRequired };
}

export function writeLocatorIndex(context, collection) {
  const path = join(context.dir, INDEX_FILENAME);
  const index = {
    version: 1, sessionId: context.identity.sessionId,
    freshness: collection.complete ? 'complete' : 'partial', digest: collection.digest,
    files: collection.files.map((file) => ({
      note_id: file.name, path: file.path, origin: file.origin, shared: file.shared,
      bytes: file.bytes, sha256: file.hash, hashComplete: file.hashComplete, status: file.status,
    })),
    unavailableLocations: collection.issues.map((issue) => ({ code: issue.code, path: issue.path, origin: issue.origin })),
  };
  const bytes = Buffer.from(`${JSON.stringify(index)}\n`);
  if (bytes.length > MAX_INDEX_BYTES) throw new RuntimeError('GUIDE_INDEX_LIMIT', 'guide locator index exceeds its durable bound', { path });
  atomicWrite(path, bytes);
  return path;
}

export function advanceCadence(context, payload, { ownTool = false, successfulSave = false, remindEvery = 10 } = {}) {
  const delivery = context.state.delivery;
  if (payload.hook_event_name === 'SessionStart' && payload.source === 'compact') {
    delivery.epoch += 1;
    delivery.completedOtherCalls = 0;
    delivery.refreshDue = true;
  }
  if (successfulSave) delivery.refreshDue = true;
  if (payload.hook_event_name !== 'PostToolUse' || ownTool || !payload.tool_response) return false;
  const key = sha256Hex(JSON.stringify([context.identity.turnId, context.identity.toolUseId]));
  if (delivery.seenTools.includes(key)) return false;
  delivery.seenTools.push(key);
  if (delivery.seenTools.length > 1024) delivery.seenTools.shift();
  delivery.completedOtherCalls += 1;
  if (delivery.completedOtherCalls < remindEvery) return false;
  delivery.completedOtherCalls = 0;
  return true;
}

function preamble(collection, payload, reminder) {
  const status = collection.complete
    ? `[agent-state ledger sha256=${collection.digest}]`
    : '[agent-state ledger freshness=partial; complete digest unavailable]';
  const parts = ['[agent-state: session guide files]', status, POLICY];
  if (payload.hook_event_name === 'SessionStart' && payload.source === 'compact') {
    parts.push('Successful compaction boundary: restore these reusable guides and continue unfinished work. Earlier context-usage estimates have expired.');
  }
  if (!collection.files.length) parts.push(collection.complete ? 'No reusable guide files are currently saved for this session or its verified immediate parent.' : 'No readable guide content is currently available in this partial collection.');
  if (!collection.complete) parts.push(`Collection is partial (${collection.issues[0]?.code ?? 'GUIDE_FRESHNESS_UNAVAILABLE'}). Own originals are retained; unavailable lineage/files will be retried at later supported hook boundaries.`);
  if (reminder) parts.push(SAVE_REMINDER);
  return parts.join('\n');
}

export function prepareGuideDelivery(context, payload, { prefix = '', ownTool = false, successfulSave = false, settings = deliverySettings() } = {}) {
  const reminder = advanceCadence(context, payload, { ownTool, successfulSave, remindEvery: settings.remindEvery });
  const collection = collectGuides(context.identity, context.lineage);
  const force = ['SessionStart', 'SubagentStart'].includes(payload.hook_event_name);
  const changed = collection.presentationKey !== context.state.delivery.lastPresentationKey;
  if (!force && !successfulSave && !context.state.delivery.refreshDue && !changed) {
    const partial = collection.complete ? '' : `[agent-state collection partial: ${collection.issues[0]?.code ?? 'GUIDE_FRESHNESS_UNAVAILABLE'}; complete freshness is unavailable and will be retried. Own original guides remain retained.]`;
    return { text: combine(prefix, [partial, reminder ? SAVE_REMINDER : ''].filter(Boolean).join('\n')), status: collection.complete ? 'unchanged' : 'partial', collection, snapshotDelivered: false, reminder };
  }
  const indexPath = join(context.dir, INDEX_FILENAME);
  try {
    const rendered = buildInjection({
      files: collection.files, issues: collection.issues, maxBytes: settings.maxBytes,
      preamble: preamble(collection, payload, reminder), prefix, event: payload.hook_event_name, indexPath,
    });
    if (rendered.indexRequired) writeLocatorIndex(context, collection);
    return { ...rendered, status: collection.complete ? 'delivered' : 'partial', collection, snapshotDelivered: true, reminder };
  } catch (error) {
    context.state.delivery.refreshDue = true;
    const text = combine(prefix, `[agent-state delivery unavailable: ${error?.code ?? 'GUIDE_DELIVERY_UNAVAILABLE'}]\nOriginal guide files remain at ${context.dir}. The derived guide delivery or locator index could not be refreshed; it will be retried. A separately committed guide save remains committed.${reminder ? `\n${SAVE_REMINDER}` : ''}`);
    if (text.length > MAX_CONTEXT_CHARS || hookOutputByteLength(payload.hook_event_name, text) >= MAX_HOOK_OUTPUT_BYTES) throw error;
    return { text, status: 'unavailable', collection, snapshotDelivered: false, reminder, error };
  }
}

export function markGuideDelivery(context, delivery) {
  if (!delivery.snapshotDelivered) return;
  context.state.delivery.lastPresentationKey = delivery.collection.presentationKey;
  // A partial prefix or unknown parent never becomes a complete current digest.
  context.state.delivery.lastDigest = delivery.collection.complete ? delivery.collection.digest : null;
  context.state.delivery.refreshDue = false;
}
