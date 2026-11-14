import type { AgentEvent, Itinerary, Participant, PersonPreferences, PlanRequest, PlanResult, PlanSetup, ReplanReasonCode, ReplanRequest } from './agent';

export type GroupState = 'collecting' | 'queued' | 'running' | 'ready' | 'failed' | 'finalized';
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface GroupMember { id: string; nickname: string; submitted: boolean; owner: boolean }
export interface MyGroupMember extends GroupMember { version: number; preferences?: PersonPreferences }
export interface StoredEvent { sequence: number; event: AgentEvent }
export interface GroupJobView {
  id: string; kind: 'plan' | 'replan'; state: JobState; attempt: number;
  events: StoredEvent[]; plans: Itinerary[]; result?: PlanResult; error?: string;
}
export interface GroupView {
  id: string; name: string; targetCount: number; setup: PlanSetup; revision: number; stateVersion: number;
  state: GroupState; createdAt: number; expiresAt: number; inviteExpiresAt: number;
  canManage: boolean; members: GroupMember[]; myMembers: MyGroupMember[]; job?: GroupJobView;
  candidates: Itinerary[];
  finalPlanId?: string; selectedPlanId?: string; lockedStopIds: string[]; replanCount: number;
}
export interface GroupCreated { group: GroupView; memberId: string; inviteToken: string; memberRecoveryToken: string; ownerRecoveryToken: string }
export interface GroupJoined { group: GroupView; memberId: string; memberRecoveryToken?: string }
export interface SaveGroupPreferences { memberId: string; version: number; preferences: PersonPreferences; submit: boolean; idempotencyKey: string }
export interface SelectGroupPlan { version: number; planId: string; lockedStopIds: string[] }
export interface ReplanGroup { version: number; rejectedStopId: string; reason: string; reasonCode?: ReplanReasonCode }
export interface FinalizeGroup { version: number; planId: string }
export interface ClaimedGroupJob {
  id: string; groupId: string; revision: number; kind: 'plan' | 'replan'; attempt: number; lease: string;
  request: PlanRequest & { preferences: { participants: Participant[] } };
  replanRequest?: ReplanRequest;
}
