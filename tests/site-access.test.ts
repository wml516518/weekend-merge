// @vitest-environment node
import { expect, it } from "vitest";
import { loginChallenge, siteAuthorization } from "../scripts/site-access.mjs";

it("allows anonymous visitors when the optional site password is not configured", () => {
  expect(siteAuthorization({})).toBeUndefined();
  expect(loginChallenge(undefined, {})).toBeUndefined();
  expect(loginChallenge("Basic invalid", {})).toBeUndefined();
});

it("does not keep WeChat visitors behind a login when only an old password is present", () => {
  const env = { WEEKEND_AUTH_PASSWORD: "legacy-password" };

  expect(siteAuthorization(env)).toBeUndefined();
  expect(loginChallenge(undefined, env)).toBeUndefined();
});

it("keeps the Basic Auth challenge opt-in through a configured password", async () => {
  const env = { WEEKEND_AUTH_ENABLED: "true", WEEKEND_AUTH_USERNAME: "owner", WEEKEND_AUTH_PASSWORD: "private" };

  const denied = loginChallenge(undefined, env);
  expect(denied?.status).toBe(401);
  expect(denied?.headers.get("www-authenticate")).toContain("Basic realm=");
  expect(await denied?.text()).toBe("请登录周末共识局。");

  expect(loginChallenge(siteAuthorization(env), env)).toBeUndefined();
});
