import type { PersonPreferences, PlanSetup } from "@/contracts/agent";
import { usePlanningStore } from "./usePlanningStore";

const setup: PlanSetup = {
  city: "上海",
  date: "2026-11-14",
  startTime: "13:00",
  endTime: "21:00",
  budget: 300,
  startingArea: "静安寺",
};

const personA: PersonPreferences = {
  interests: ["展览", "咖啡"],
  pace: "轻松",
  walkingLimitKm: 3,
  indoorPreference: "室内优先",
  foodTags: ["本帮菜"],
  budgetStyle: "平衡",
  avoid: ["长距离步行"],
  wish: "想看一个安静的展览",
};

const personB: PersonPreferences = {
  interests: ["城市散步", "夜景"],
  pace: "平衡",
  walkingLimitKm: 5,
  indoorPreference: "均可",
  foodTags: ["本帮菜"],
  budgetStyle: "体验优先",
  avoid: ["排队"],
  wish: "想在天黑前后看看城市",
};

describe("usePlanningStore", () => {
  beforeEach(() => {
    localStorage.clear();
    usePlanningStore.getState().reset();
  });

  it("starts a new setup without carrying either previous private answer", () => {
    const store = usePlanningStore.getState();
    store.savePreferences("a", personA);
    store.savePreferences("b", personB);
    store.saveSetup({ ...setup, budget: 600 });
    expect(usePlanningStore.getState().preferences).toEqual({});
  });

  it("advances through private handoff while preserving both preferences", () => {
    expect(usePlanningStore.getState().stage).toBe("setup");

    usePlanningStore.getState().saveSetup(setup);
    expect(usePlanningStore.getState().stage).toBe("person-a");

    usePlanningStore.getState().savePreferences("a", personA);
    expect(usePlanningStore.getState().stage).toBe("handoff");

    usePlanningStore.getState().handoffToB();
    expect(usePlanningStore.getState().stage).toBe("person-b");

    usePlanningStore.getState().savePreferences("b", personB);
    expect(usePlanningStore.getState()).toMatchObject({
      stage: "consensus",
      setup,
      preferences: { a: personA, b: personB },
    });
  });
});
