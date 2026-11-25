import { roomId } from './channel-hex.js';

export const deriveRoomId = async (serverId, channel) => 'zellous' + (await roomId(serverId, 'voice', channel)).slice(0, 16);
