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
    if (url.includes("/api/inspection/prompt")) {
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

  it("keeps the Bike nav intact when Boat capture is disabled", async () => {
    stubBoatFetch({ captureEnabled: false });
    window.location.hash = "#/history";
    renderShell();
    await waitFor(() => expect(screen.getByRole("link", { name: "Context" })).toBeTruthy());
    expect(screen.getByRole("link", { name: "History" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
  });
});
