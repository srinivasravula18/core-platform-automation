import type { MissionContext } from '../mission/missionContext';
import type { MissionRef } from './state';

export function missionContextFromRef(ref: MissionRef): MissionContext;
export function missionContextFromRef(ref: MissionRef | null): MissionContext | null;
export function missionContextFromRef(ref: MissionRef | null): MissionContext | null {
  if (!ref) return null;
  return Object.freeze({
    platform: ref.platform,
    platformType: ref.platformType,
    runtimeSurface: ref.runtimeSurface,
    application: ref.applicationId ? { id: ref.applicationId, name: ref.applicationId } : null,
    module: ref.moduleId ? { id: ref.moduleId, name: ref.moduleId } : null,
    tab: ref.tabId ? { id: ref.tabId, name: ref.tabId } : null,
    targetUrl: ref.targetUrl,
    executionScope: ref.executionScope,
  });
}
