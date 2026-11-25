export const HUB_SILENCE_FLOOR_MS = 4000;
export const HUB_SILENCE_CEIL_MS = 8000;
export const STALL_GAP_MS = 2500;
export const STALL_GRACE_MS = 1500;
const JITTER_DECAY = 0.9;
const JITTER_WARMUP = 3;
const JITTER_FACTOR = 3;

export const newLink = () => ({ hbAt: 0, netAt: 0, count: null, last: 0, jitter: 0, sampling: false, seen: 0 });

export const linkOf = (peer) => (peer.link || (peer.link = newLink()));

const evidence = (link, now, calm) => {
  link.seen += 1;
  if (calm && link.last && link.seen > JITTER_WARMUP) link.jitter = Math.max(Math.min(now - link.last, HUB_SILENCE_CEIL_MS), link.jitter * JITTER_DECAY);
  link.last = now;
};

export const noteHeartbeat = (link, now, calm) => {
  link.hbAt = now;
  evidence(link, now, calm);
};

export const noteTransport = (link, count, now, calm) => {
  if (link.count === null || count > link.count) {
    link.netAt = now;
    evidence(link, now, calm);
  }
  link.count = count;
};

export const transportBytes = async (pc) => {
  const stats = await pc.getStats();
  let transport = 0;
  let pair = 0;
  stats.forEach((r) => {
    if (r.type === 'transport') transport += r.bytesReceived || 0;
    if (r.type === 'candidate-pair' && (r.nominated || r.selected)) pair += r.bytesReceived || 0;
  });
  return Math.max(transport, pair);
};

export const silenceMs = (link, now) => {
  const at = Math.max(link.hbAt, link.netAt);
  return at ? now - at : 0;
};

export const thresholdMs = (link) => Math.min(HUB_SILENCE_CEIL_MS, Math.max(HUB_SILENCE_FLOOR_MS, link.jitter * JITTER_FACTOR));

export const linkAlive = (peer, now) => {
  if (!peer) return false;
  const link = linkOf(peer);
  return (link.hbAt || link.netAt) > 0 && silenceMs(link, now) <= thresholdMs(link);
};
