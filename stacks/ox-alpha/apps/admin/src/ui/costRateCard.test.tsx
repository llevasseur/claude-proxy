// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CostRateCard } from "./costRateCard";

afterEach(cleanup);

const USAGE = {
  inputTokens: 1000,
  cachedInputTokens: 400,
  outputTokens: 500,
  reasoningOutputTokens: 100,
  totalTokens: 1500,
};

describe("CostRateCard", () => {
  it("recomputes listed usage under operator rates with exact arithmetic", () => {
    render(<CostRateCard usage={USAGE} />);
    expect(screen.getByTestId("cost-rate-result").textContent).toContain("Enter rates");

    // Fresh input 600 * $1/MTok + cached 400 * $0.1 + output 500 * $2
    // (reasoning included in output) = 0.0006 + 0.00004 + 0.001 = 0.00164 USD.
    fireEvent.change(screen.getByTestId("cost-rate-input"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("cost-rate-cachedInput"), { target: { value: "0.1" } });
    fireEvent.change(screen.getByTestId("cost-rate-output"), { target: { value: "2" } });
    expect(screen.getByTestId("cost-rate-result").textContent).toContain("$0.00164");
  });

  it("rejects non-decimal rates without inventing a number", () => {
    render(<CostRateCard usage={USAGE} />);
    fireEvent.change(screen.getByTestId("cost-rate-input"), { target: { value: "cheap" } });
    expect(screen.getByTestId("cost-rate-result").textContent).toContain(
      "Rates must be decimal numbers",
    );
  });

  it("persists overrides across remounts", () => {
    const { unmount } = render(<CostRateCard usage={USAGE} />);
    fireEvent.change(screen.getByTestId("cost-rate-input"), { target: { value: "3" } });
    unmount();
    render(<CostRateCard usage={USAGE} />);
    expect((screen.getByTestId("cost-rate-input") as HTMLInputElement).value).toBe("3");
  });
});
