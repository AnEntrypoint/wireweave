import { registerProtocol } from './registry.js';

export const HELLO_TAG = 'hello-room';

export const greeting = (name) => 'hello ' + String(name || 'there').slice(0, 40);

registerProtocol({ id: 'hello-room', channelTypes: ['hello-room'], eventKinds: [], greeting });
