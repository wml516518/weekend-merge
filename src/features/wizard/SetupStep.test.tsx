import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { SetupStep } from "./SetupStep";

describe("SetupStep", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T04:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("submits a valid Shanghai weekend setup", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<SetupStep onSubmit={onSubmit} />);

    const continueButton = screen.getByRole("button", {
      name: "填写 A 的偏好",
    });
    expect(continueButton).toBeDisabled();

    await user.type(screen.getByLabelText("日期"), "2026-11-14");
    await user.clear(screen.getByLabelText("总预算"));
    await user.type(screen.getByLabelText("总预算"), "300");
    await user.selectOptions(screen.getByLabelText("出发区域"), "静安寺");
    await user.click(continueButton);

    expect(onSubmit).toHaveBeenCalledWith({
      city: "上海",
      date: "2026-11-14",
      startTime: "13:00",
      endTime: "21:00",
      budget: 300,
      startingArea: "静安寺",
    });
  });
});
