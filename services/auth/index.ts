export { registerAuthRoutes, authContextMiddleware, apiAuthGate } from '../../server/features/auth/routes';
export { seedAuthUsersIfEmpty, claimLegacyDataForAdmin } from '../../server/features/auth/userStore';
