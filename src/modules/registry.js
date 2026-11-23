const protocols = new Map();

export function registerProtocol(p) {
  if (!p || typeof p.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(p.id)) throw new Error('protocol id must be lowercase letters, digits and dashes');
  if (protocols.has(p.id)) throw new Error('protocol ' + p.id + ' is already registered');
  protocols.set(p.id, { channelTypes: [], eventKinds: [], ...p });
  return p.id;
}

export const protocolList = () => [...protocols.values()];
export const protocolFor = (id) => protocols.get(id) || null;
export const protocolForChannelType = (type) => protocolList().find((p) => p.channelTypes.includes(type)) || null;
