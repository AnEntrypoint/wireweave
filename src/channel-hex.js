const toHex = (buffer) => Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');

export const requireScope = (serverId, channelId, who) => {
  if (!serverId || typeof serverId !== 'string') throw new Error(who + ': serverId required');
  if (!channelId || typeof channelId !== 'string') throw new Error(who + ': channelId required');
};

export const hexChannelId = async (channelId, serverId) => {
  requireScope(serverId, channelId, 'hexChannelId');
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serverId + ':' + channelId)));
};

export const roomId = async (serverId, kind, channel) => {
  requireScope(serverId, channel, 'roomId');
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serverId + ':' + kind + ':' + channel)));
};
