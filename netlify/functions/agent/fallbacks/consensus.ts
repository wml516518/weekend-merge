import {
  ConsensusSummarySchema,
  type ConsensusSummary,
  type PlanRequest,
} from "../../../../src/contracts/agent";
import { getParticipants } from "../../../../src/contracts/agent";
import { effectiveWalkingLimitKm } from "../tools/preferences";

export function analyzeConsensus(request: Pick<PlanRequest, "setup" | "preferences">): ConsensusSummary {
  const people = getParticipants(request.preferences);
  const shared = people.length >= 2 ? people[0].preferences.interests.filter((interest) =>
    people.slice(1).every((person) => person.preferences.interests.includes(interest))) : [];
  const conflicts: string[] = [];
  for (const field of ["pace", "indoorPreference"] as const) {
    const values = new Set(people.map((person) => person.preferences[field]));
    if (values.size > 1) conflicts.push(`${field === "pace" ? "节奏" : "室内外"}偏好不同：${[...values].join(" / ")}`);
  }
  const walkingValues = new Set(people.map((person) => person.preferences.walkingLimitKm));
  if (walkingValues.size > 1) conflicts.push(`步行上限不同：${[...walkingValues].join(" / ")} 公里`);

  const publicAvoidLabels = new Set(["排队", "拥挤", "辛辣", "酒吧", "长距离步行", "早起", "户外日晒"]);
  const avoided = [...new Set(people.flatMap((person) => person.preferences.avoid))].filter((label) => publicAvoidLabels.has(label));
  const constraints = [
    `总预算 ${request.setup.budget} 元`,
    `步行上限 ${effectiveWalkingLimitKm(request.preferences)} 公里`,
    `活动时间 ${request.setup.startTime}-${request.setup.endTime}`,
    ...avoided.map((tag) => `避开：${tag}`),
  ];
  return ConsensusSummarySchema.parse({ shared, conflicts, constraints });
}
