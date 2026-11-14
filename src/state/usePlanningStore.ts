import type {
  AgentEvent,
  Itinerary,
  PersonPreferences,
  PlanDiff,
  PlanSetup,
} from "@/contracts/agent";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PlanningStage =
  | "setup"
  | "person-a"
  | "handoff"
  | "person-b"
  | "consensus"
  | "workbench"
  | "final";
export type PlanChange = {
  planId: string;
  stopId: string;
  before: string;
  after: string;
  reason: string;
  note: string;
  replacementStopId?: string;
  diff?: PlanDiff;
};
type PlanningStore = {
  stage: PlanningStage;
  setup?: PlanSetup;
  preferences: { a?: PersonPreferences; b?: PersonPreferences };
  activePlanId?: string;
  activeStopId?: string;
  lockedStops: string[];
  likedStops: string[];
  revisedPlans: Record<string, Itinerary>;
  changes: PlanChange[];
  replanCount: number;
  finalPlan?: Itinerary;
  mode: "demo" | "live";
  sessionId?: string;
  liveEvents: AgentEvent[];
  saveSetup: (setup: PlanSetup) => void;
  savePreferences: (person: "a" | "b", preferences: PersonPreferences) => void;
  handoffToB: () => void;
  revealConsensus: () => void;
  openWorkbench: (mode: "demo" | "live", sessionId?: string) => void;
  goTo: (stage: PlanningStage) => void;
  selectPlan: (id: string) => void;
  selectStop: (id: string) => void;
  toggleLocked: (id: string) => void;
  toggleLiked: (id: string) => void;
  replaceDemoStop: (
    plan: Itinerary,
    stopId: string,
    reason: string,
    note: string,
  ) => boolean;
  applyReplan: (baseId: string, plan: Itinerary, change: PlanChange) => void;
  finalize: (plan: Itinerary) => void;
  reset: () => void;
};
const emptyNegotiation = {
  activePlanId: undefined,
  activeStopId: undefined,
  lockedStops: [] as string[],
  likedStops: [] as string[],
  revisedPlans: {} as Record<string, Itinerary>,
  changes: [] as PlanChange[],
  replanCount: 0,
  finalPlan: undefined,
};
const initialState = {
  stage: "setup" as const,
  setup: undefined,
  preferences: {},
  mode: "demo" as const,
  sessionId: undefined,
  liveEvents: [] as AgentEvent[],
  ...emptyNegotiation,
};
export const usePlanningStore = create<PlanningStore>()(
  persist(
    (set, get) => ({
      ...initialState,
      saveSetup: (setup) =>
        set({
          setup,
          preferences: {},
          stage: "person-a",
          sessionId: undefined,
          liveEvents: [],
          ...emptyNegotiation,
        }),
      savePreferences: (person, preferences) =>
        set((state) => ({
          preferences: { ...state.preferences, [person]: preferences },
          stage: person === "a" ? "handoff" : "consensus",
        })),
      handoffToB: () => set({ stage: "person-b" }),
      revealConsensus: () => set({ stage: "consensus" }),
      openWorkbench: (mode, sessionId) =>
        set({
          stage: "workbench",
          mode,
          sessionId,
          liveEvents: [],
          ...emptyNegotiation,
        }),
      goTo: (stage) => set({ stage }),
      selectPlan: (id) => set({ activePlanId: id, activeStopId: undefined }),
      selectStop: (id) => set({ activeStopId: id }),
      toggleLocked: (id) =>
        set((state) => ({
          lockedStops: state.lockedStops.includes(id)
            ? state.lockedStops.filter((x) => x !== id)
            : [...state.lockedStops, id],
        })),
      toggleLiked: (id) =>
        set((state) => ({
          likedStops: state.likedStops.includes(id)
            ? state.likedStops.filter((x) => x !== id)
            : [...state.likedStops, id],
        })),
      replaceDemoStop: (plan, stopId, reason, note) => {
        const state = get();
        const current = state.revisedPlans[plan.id] ?? plan;
        const stop = current.stops.find((x) => x.id === stopId);
        if (
          !stop ||
          !reason.trim() ||
          state.replanCount >= 2 ||
          stop.locked ||
          state.lockedStops.includes(stopId) ||
          state.changes.some((c) => c.stopId === stopId)
        )
          return false;
        // A same-area, equal-cost fixture illustrates negotiation without impersonating a real search.
        const name = stop.tags.includes("咖啡")
          ? "街区安静咖啡空间（演示替代）"
          : stop.tags.includes("晚餐")
            ? "邻里家常小馆（演示替代）"
            : "街区小型艺术空间（演示替代）";
        const revised = {
          ...current,
          stops: current.stops.map((x) =>
            x.id === stopId
              ? {
                  ...x,
                  name,
                  placeId: `demo-replacement-${x.placeId}`,
                  tags: [...x.tags, "演示替代"],
                }
              : x,
          ),
        };
        set({
          revisedPlans: { ...state.revisedPlans, [plan.id]: revised },
          changes: [
            ...state.changes,
            {
              planId: plan.id,
              stopId,
              before: stop.name,
              after: name,
              reason,
              note: note.slice(0, 60),
            },
          ],
          replanCount: state.replanCount + 1,
        });
        return true;
      },
      applyReplan: (baseId, plan, change) =>
        set((state) => ({
          revisedPlans: { ...state.revisedPlans, [baseId]: plan },
          changes: [...state.changes, change],
          activeStopId: change.replacementStopId,
          likedStops: state.likedStops.filter((id) => id !== change.stopId),
          replanCount: state.replanCount + 1,
        })),
      finalize: (plan) =>
        set((state) => ({
          stage: "final",
          finalPlan: {
            ...plan,
            stops: plan.stops.map((stop) => ({
              ...stop,
              locked: stop.locked || state.lockedStops.includes(stop.id),
            })),
          },
        })),
      reset: () => set(initialState),
    }),
    {
      name: "weekend-merge-session",
      partialize: ({
        stage,
        setup,
        preferences,
        activePlanId,
        activeStopId,
        lockedStops,
        likedStops,
        revisedPlans,
        changes,
        replanCount,
        finalPlan,
        mode,
        sessionId,
        liveEvents,
      }) => ({
        stage,
        setup,
        preferences,
        activePlanId,
        activeStopId,
        lockedStops,
        likedStops,
        revisedPlans,
        changes,
        replanCount,
        finalPlan,
        mode,
        sessionId,
        liveEvents,
      }),
    },
  ),
);
