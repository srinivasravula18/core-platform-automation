export { registerAutomationRoutes } from '../../server/features/automation/routes';
export { isRemoteAgentEnabled } from '../../server/features/automation/flag';
export { attachAutomationGateway } from '../../server/features/automation/agentGateway';
export { startScheduler, stopScheduler } from '../../server/features/automation/schedulerService';
export { recoverOrphanedJobs } from '../../server/features/automation/jobService';
