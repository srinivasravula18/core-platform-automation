export { registerAuthRoutes, authContextMiddleware, apiAuthGate } from '../../server/features/auth/routes';
export { seedAuthUsersIfEmpty, claimLegacyDataForAdmin } from '../../server/features/auth/userStore';
export { hydrateAuthFromPg, seedRbacCatalog } from '../../server/features/auth/authRepo';
export { rbacGate, isRbacEnforced } from '../../server/features/auth/rbacGate';
