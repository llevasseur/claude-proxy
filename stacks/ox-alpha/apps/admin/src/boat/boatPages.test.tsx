// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeEventSource,
  healthPayload,
  installTestGlobals,
  renderShell,
  stubFetch,
} from "../car/testSupport";

beforeEach(() => {
  FakeEventSource.instances = [];
  installTestGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

function inspectionPage(records: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    captureEnabled: true,
    total: records.length,
    offset: 0,
    limit: 25,
    nextOffset: null,
    records,
    ...overrides,
  };
}

const contextRecord = {
  recordId: "rec-1",
  capturedAt: "2026-08-20T10:00:00.000Z",
  endpoint: "/v1/responses",
  model: "gpt-5",
  messageCount: 2,
  instructionsPresent: true,
  toolCount: 1,
  toolCallCount: 1,
  sessionId: "sess-rec-1",
};

function stubBoatFetch(options: Readonly<{ captureEnabled?: boolean }>) {
  return stubFetch((url) => {
    if (url.includes("/api/health")) {
      const health = healthPayload() as Record<string, unknown>;
      return { ...health, capture: { enabled: options.captureEnabled ?? true } };
    }
    // A disabled server serves typed empty inspection payloads.
    if (options.captureEnabled === false) return inspectionPage([], { captureEnabled: false });
    if (url.includes("/api/inspection/day")) return inspectionPage([contextRecord]);
    if (url.includes("/api/inspection/messages")) {
      return inspectionPage([
        { recordId: "rec-1", role: "user", itemType: "message", text: "hello" },
      ]);
    }
    if (url.includes("/api/inspection/prompt?")) {
      return {
        captureEnabled: true,
        parsed: true,
        model: "gpt-5",
        instructionsPresent: true,
        instructionsChars: 9,
        inputMessageCount: 2,
        inputChars: 24,
        toolCount: 1,
        estimatedInputTokens: 9,
      };
    }
    if (url.includes("/api/inspection/prompt-sections")) {
      return {
        captureEnabled: true,
        instructionsHash: "abc123def4567890",
        sections: [
          { kind: "instructions", index: null, role: null, itemType: null, chars: 9 },
          { kind: "message", index: 0, role: "user", itemType: "message", chars: 5 },
        ],
      };
    }
    if (url.includes("/api/inspection/prompt-mix")) {
      return {
        captureEnabled: true,
        date: "2026-08-20",
        requests: 2,
        meanChars: 12,
        medianChars: 12,
        identifiedShare: 1,
        cohorts: [
          {
            key: "abc123def4567890",
            label: "prompt:abc123def456",
            identified: true,
            hash: "abc123def4567890",
            models: ["gpt-5"],
            requests: 2,
            share: 1,
            meanChars: 12,
            totalChars: 24,
            contribution: 12,
          },
        ],
      };
    }
    if (url.includes("/api/inspection/prompts")) {
      return inspectionPage([
        {
          recordId: "rec-1",
          capturedAt: contextRecord.capturedAt,
          model: "gpt-5",
          instructionsHash: "abc123def4567890",
          sectionCount: 3,
        },
      ]);
    }
    if (url.includes("/api/inspection/tools")) {
      return inspectionPage([
        {
          recordId: "rec-1",
          capturedAt: contextRecord.capturedAt,
          name: "get_weather",
          type: "function",
          description: null,
          schemaJson: "{}",
        },
      ]);
    }
    if (url.includes("/api/inspection/sessions")) {
      return inspectionPage([
        {
          sessionId: "sess-rec-1",
          captureCount: 1,
          firstCapturedAt: contextRecord.capturedAt,
          lastCapturedAt: contextRecord.capturedAt,
          recordIds: ["rec-1"],
        },
      ]);
    }
    return inspectionPage([]);
  });
}

describe("Boat inspection routes", () => {
  it("explains that Boat capture is off instead of showing an empty table", async () => {
    stubBoatFetch({ captureEnabled: false });
    window.location.hash = "#/boat";
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("boat-context-no-capture").textContent).toContain(
        "Boat capture is off",
      ),
    );
    expect(screen.queryByTestId("boat-context-table")).toBeNull();
  });

  it("shows a loading state before data arrives", async () => {
    stubFetch(() => new Promise(() => {}));
    window.location.hash = "#/boat";
    renderShell();
    await waitFor(() => expect(screen.getByTestId("boat-context-loading")).toBeTruthy());
  });

  it("lists captured exchanges and links to messages and prompt surfaces", async () => {
    const fetchMock = stubBoatFetch({});
    window.location.hash = "#/boat";
    renderShell();
    await waitFor(() => expect(screen.getByTestId("boat-context-table")).toBeTruthy());
    expect(screen.getByText("rec-1").tagName).toBe("A");
    expect((screen.getByText("prompt") as HTMLAnchorElement).href).toContain(
      "#/boat/prompt?recordId=rec-1",
    );

    fireEvent.click(screen.getByText("rec-1"));
    await waitFor(() => expect(screen.getByTestId("boat-message-list")).toBeTruthy());
    expect(screen.getByText("hello")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("recordId=rec-1"))).toBe(true);
  });

  it("renders the prompt analysis surface without body text", async () => {
    stubBoatFetch({});
    window.location.hash = "#/boat/prompt?recordId=rec-1";
    renderShell();
    await waitFor(() => expect(screen.getByTestId("boat-prompt-analysis")).toBeTruthy());
    expect(screen.getByTestId("boat-prompt-analysis").textContent).toContain("Estimated");
  });

  it("renders tool schemas, sessions, and keeps capture-off notices per route", async () => {
    stubBoatFetch({ captureEnabled: true });
    window.location.hash = "#/boat/tools";
    renderShell();
    await waitFor(() => expect(screen.getByTestId("boat-tools-table")).toBeTruthy());

    cleanup();
    window.location.hash = "#/boat/sessions";
    renderShell();
    await waitFor(() => expect(screen.getByTestId("boat-sessions-table")).toBeTruthy());
    expect(screen.getByText("sess-rec-1")).toBeTruthy();
  });

  it("renders the prompt mix and drills down by cohort hash to prompts", async () => {
    const fetchMock = stubBoatFetch({});
    window.location.hash = "#/boat/prompt-mix";
    renderShell();
    await waitFor(() => expect(screen.getByTestId("boat-prompt-mix")).toBeTruthy());
    const drill = screen.getByText("prompt:abc123def456") as HTMLAnchorElement;
    expect(drill.href).toContain("#/boat/prompts?hash=abc123def4567890");

    fireEvent.click(drill);
    await waitFor(() => expect(screen.getByTestId("boat-prompts-table")).toBeTruthy());
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("hash=abc123def4567890")),
    ).toBe(true);
  });

  it("shows prompt sections with sizes but no body text on the prompt page", async () => {
    stubBoatFetch({});
    window.location.hash = "#/boat/prompt?recordId=rec-1";
    renderShell();
    await waitFor(() => expect(screen.getByTestId("boat-prompt-sections")).toBeTruthy());
    const text = screen.getByTestId("boat-prompt-sections").textContent ?? "";
    expect(text).toContain("instructions");
    expect(text).toContain("input #0");
    expect(text).not.toContain("hello");
  });

  it("keeps the Bike nav intact when Boat capture is disabled", async () => {
    stubBoatFetch({ captureEnabled: false });
    window.location.hash = "#/history";
    renderShell();
    await waitFor(() => expect(screen.getByRole("link", { name: "Context" })).toBeTruthy());
    expect(screen.getByRole("link", { name: "History" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
  });
});
