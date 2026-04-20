export const LEGACY_LOAD_ORDER = [
  'nostr-state-patch.js',
  'nostr-fsm.js',
  'nostr-network.js',
  'nostr-auth.js',
  'nostr-message.js',
  'nostr-bans.js',
  'nostr-roles.js',
  'nostr-settings.js',
  'nostr-voice.js',
  'nostr-voice-rtc.js',
  'nostr-voice-sfu.js',
  'nostr-voice-camera.js',
  'nostr-chat.js',
  'nostr-channels.js',
  'nostr-servers.js',
  'nostr-media.js',
  'nostr-pages.js'
];

export const loadLegacy = async ({ base = 'https://cdn.jsdelivr.net/npm/magicwand@latest/src/legacy/', prereqsReady = () => true } = {}) => {
  if (!prereqsReady()) throw new Error('magicwand/legacy: prereqs not ready (state, XState, NostrTools must be on window)');
  for (const f of LEGACY_LOAD_ORDER) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = base + f;
      s.onload = resolve;
      s.onerror = () => reject(new Error('failed: ' + f));
      document.head.appendChild(s);
    });
  }
  return {
    net: window.nostrNet,
    auth: window.auth,
    voice: window.nostrVoice,
    chat: window.chat,
    channels: window.channelManager,
    servers: window.serverManager,
    message: window.message,
    bans: window.nostrBans,
    roles: window.serverRoles,
    settings: window.serverSettings,
    pages: window.serverPages,
    media: window.nostrMedia,
    voiceRtc: window.nostrVoiceRtc,
    voiceSfu: window.nostrVoiceSfu,
    voiceCamera: window.nostrVoiceCamera
  };
};
