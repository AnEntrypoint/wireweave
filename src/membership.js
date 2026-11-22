export const GREETINGS = ['just showed up!', 'joined the party.', 'is here.', 'hopped into the server.', 'just landed.', 'slid into the server.'];

const JOIN_MARK = '→¦join¦';
const WAVE_MARK = '👋¦wave¦';
const INVITE_MARK = '📨';
const SERVER_ID_RE = /^[0-9a-f]{64}:.+$/;
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

export const greetingFor = (pubkey) => GREETINGS[parseInt(String(pubkey || '0').slice(0, 8), 16) % GREETINGS.length];

export const joinContent = (greeting) => JOIN_MARK + greeting;

export const parseJoin = (content) => {
  const s = String(content || '');
  if (!s.startsWith(JOIN_MARK)) return null;
  const greeting = s.slice(JOIN_MARK.length);
  return GREETINGS.includes(greeting) ? greeting : null;
};

export const waveContent = (pubkey) => WAVE_MARK + pubkey;

export const parseWave = (content) => {
  const m = /^👋¦wave¦([0-9a-f]{64})$/.exec(String(content || ''));
  return m ? m[1] : null;
};

export const inviteContent = ({ serverId, name, color }) => [INVITE_MARK, serverId, String(name || '').replace(/¦/g, ''), color || '#5865F2'].join('¦');

export const parseInvite = (content) => {
  const parts = String(content || '').split('¦');
  if (parts[0] !== INVITE_MARK || parts.length !== 4) return null;
  const [, serverId, name, color] = parts;
  return { serverId, name, color: COLOR_RE.test(color) ? color : '#5865F2', valid: SERVER_ID_RE.test(serverId) && name.length > 0 };
};
