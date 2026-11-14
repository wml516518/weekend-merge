const INTEREST_TAGS: Record<string, readonly string[]> = {
  "展览": ["展览", "艺术", "当代艺术", "历史", "文物", "文化"],
  "咖啡": ["咖啡", "烘焙", "休息"],
  "城市散步": ["散步", "江景", "文化"],
  "自然": ["公园", "绿地", "江景"],
  "电影": ["电影"],
  "桌游": ["桌游"],
  "夜景": ["夜景", "江景"],
  "逛店": ["书店", "阅读", "文化"],
  "美食": ["晚餐", "本帮菜", "传统"],
};

const AVOID_TAGS: Record<string, readonly string[]> = {
  "排队": ["排队"],
  "拥挤": ["拥挤", "排队"],
  "辛辣": ["辛辣", "川菜", "火锅"],
  "酒吧": ["酒吧"],
};

type WalkingPreference = { walkingLimitKm: number; avoid: readonly string[] };
type WalkingPerson = { preferences: WalkingPreference };
type WalkingPreferences = { a: WalkingPreference; b: WalkingPreference } | { participants: readonly WalkingPerson[] };

export function interestMatchesTags(interest: string, tags: readonly string[]): boolean {
  return (Object.hasOwn(INTEREST_TAGS, interest) ? INTEREST_TAGS[interest] : [interest]).some((tag) => tags.includes(tag));
}

export function expandedAvoidTags(avoid: readonly string[]): string[] {
  return [...new Set(avoid.flatMap((label) => (Object.hasOwn(AVOID_TAGS, label) ? AVOID_TAGS[label] : undefined) ??
    (["长距离步行", "早起", "户外日晒"].includes(label) ? [] : [label])))];
}

export function effectiveWalkingLimitKm(preferences: WalkingPreferences): number {
  const mapped = "participants" in preferences ? preferences.participants.map((person) => person.preferences) : [preferences.a, preferences.b];
  const limit = Math.min(...mapped.map((person) => person.walkingLimitKm));
  return mapped.some((person) => person.avoid.includes("长距离步行")) ? Math.min(limit, 1) : limit;
}

// Count each person once for coverage; rank rewards earlier choices after coverage ties.
export function interestCoverage(people: readonly { preferences: { interests: readonly string[] } }[], venues: readonly { tags: readonly string[] }[]) {
  let covered = 0;
  let support = 0;
  let rank = 0;
  for (const person of people) {
    if (person.preferences.interests.some((interest) => venues.some((venue) => interestMatchesTags(interest, venue.tags)))) covered += 1;
    for (const venue of venues) {
      const firstMatch = person.preferences.interests.findIndex((interest) => interestMatchesTags(interest, venue.tags));
      if (firstMatch >= 0) {
        support += 1;
        rank += person.preferences.interests.length - firstMatch;
      }
    }
  }
  return { covered, support, rank };
}

export function interestCoverageReason(people: readonly { preferences: { interests: readonly string[] } }[], venues: readonly { tags: readonly string[] }[]): string {
  return `行程覆盖 ${interestCoverage(people, venues).covered}/${people.length} 位成员的兴趣`;
}

export function violatesAvoidedStop(avoid: readonly string[], tags: readonly string[], indoor: boolean, startTime: string): boolean {
  const excludedTags = expandedAvoidTags(avoid);
  return tags.some((tag) => excludedTags.includes(tag)) ||
    (avoid.includes("早起") && startTime < "10:00") ||
    (avoid.includes("户外日晒") && !indoor && startTime < "18:00");
}
