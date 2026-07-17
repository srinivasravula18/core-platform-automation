export { registerAgentRuntimeRoutes } from '../../server/agent-runtime/routes';
// Conversational Runtime (strangler boundary): new runtime exports live beside the legacy registration.
export * as conversationalRuntime from './src/index';
export { registerConversationalRuntimeRoutes, conversationalRuntimeEnabled } from './src/api/routes';
