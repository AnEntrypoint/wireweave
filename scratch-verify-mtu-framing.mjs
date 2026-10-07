

import { fragment, Reassembler, MTU_DEFAULT, maxPayloadBytes } from './src/frame.js';
import crypto from 'node:crypto';
import assert from 'node:assert';

let passed = 0;
const check = (label, cond) => {
  assert.ok(cond, label);
  passed++;
  console.log('  ok:', label);
};

console.log('=== MTU-aware binary framing: real round-trip verification ===\n');

console.log('[1] large payload, shuffled (unordered) delivery');
{
  const payload = crypto.randomBytes(250000);
  const messageId = 101;
  const frames = fragment(payload, { messageId, mtu: MTU_DEFAULT });
  check('fragmented into >1 wire fragment', frames.length > 1);
  console.log('  fragments:', frames.length, 'payload bytes:', payload.length);

  const shuffled = [...frames].sort(() => Math.random() - 0.5);
  const reassembler = new Reassembler({ staleMs: 10000 });
  let reassembled = null;
  for (const f of shuffled) {
    const out = reassembler.feed(f);
    if (out) reassembled = out;
  }
  check('reassembled once all fragments arrived (any order)', reassembled !== null);
  check('reassembled length matches original', reassembled.length === payload.length);
  check('reassembled bytes are byte-identical to original', Buffer.from(reassembled).equals(payload));
  check('no leftover in-flight sets after a full completion', reassembler.pendingCount() === 0);
}

console.log('\n[2] deliberately dropped fragment -> stale cleanup, not a leak');
{
  const payload = crypto.randomBytes(80000);
  const messageId = 202;
  const frames = fragment(payload, { messageId, mtu: MTU_DEFAULT });
  check('multi-fragment message for the drop test', frames.length > 2);

  const staleMs = 150;
  const reassembler = new Reassembler({ staleMs, maxInFlight: 32 });
  const droppedIndex = Math.floor(frames.length / 2);
  const delivered = frames.filter((_, i) => i !== droppedIndex);

  let completedEarly = null;
  for (const f of delivered) {
    const out = reassembler.feed(f);
    if (out) completedEarly = out;
  }
  check('message never completes with a fragment missing', completedEarly === null);
  check('incomplete set is buffered (not silently discarded)', reassembler.has(messageId));
  check('exactly one in-flight set is being tracked', reassembler.pendingCount() === 1);

  await new Promise((r) => setTimeout(r, staleMs + 250));
  const evicted = reassembler.sweep();
  check('sweep evicts the stale incomplete set', evicted === 1);
  check('the stale messageId is gone after sweep (graceful cleanup, no leak)', !reassembler.has(messageId));
  check('pendingCount is back to zero', reassembler.pendingCount() === 0);
}

console.log('\n[3] bounded memory under many concurrent never-completing messages');
{
  const maxInFlight = 8;
  const reassembler = new Reassembler({ staleMs: 999999, maxInFlight });
  for (let id = 0; id < 20; id++) {
    const payload = crypto.randomBytes(40000);
    const frames = fragment(payload, { messageId: id, mtu: MTU_DEFAULT });

    for (const f of frames.slice(0, -1)) reassembler.feed(f);
  }
  check('pendingCount never exceeds maxInFlight even with 20 never-completing messages', reassembler.pendingCount() <= maxInFlight);
  console.log('  pendingCount after 20 incomplete messages (cap=' + maxInFlight + '):', reassembler.pendingCount());
}

console.log('\n[4] duplicate fragment delivery does not corrupt reassembly');
{
  const payload = crypto.randomBytes(30000);
  const frames = fragment(payload, { messageId: 303, mtu: MTU_DEFAULT });
  const reassembler = new Reassembler();

  reassembler.feed(frames[0]);
  reassembler.feed(frames[0]);
  reassembler.feed(frames[0]);
  check('duplicate feeds of the same fragment keep exactly one in-flight set', reassembler.pendingCount() === 1);
  let result = null;
  for (let i = 1; i < frames.length; i++) { const out = reassembler.feed(frames[i]); if (out) result = out; }
  check('reassembly still completes correctly despite duplicate delivery', result !== null && Buffer.from(result).equals(payload));
}

console.log('\n[5] zero-length payload edge case');
{
  const frames = fragment(new Uint8Array(0), { messageId: 404, mtu: MTU_DEFAULT });
  check('empty payload still produces exactly one fragment', frames.length === 1);
  const reassembler = new Reassembler();
  const out = reassembler.feed(frames[0]);
  check('empty payload reassembles immediately to a zero-length result', out !== null && out.length === 0);
}

console.log('\n[6] payload exceeding the wire-format fragment-count ceiling');
{
  const tinyMtu = 20;
  const tooLarge = maxPayloadBytes(tinyMtu) + 5000;
  let threw = false;
  try { fragment(new Uint8Array(tooLarge), { messageId: 505, mtu: tinyMtu }); }
  catch (e) { threw = /fragments/.test(e.message); }
  check('oversized payload throws a clear fragment-count-ceiling error', threw);
}

console.log('\n=== ' + passed + ' checks passed ===');
