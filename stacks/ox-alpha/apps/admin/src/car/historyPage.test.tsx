// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeEventSource,
  historyPageResponse,
  historyRecord,
  installTestGlobals,
  renderShell,
  stubFetch,
} from "./testSupport";

beforeEach(() => {
  FakeEventSource.instances = [];
  installTestGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

function urls(fetchMock: ReturnType<typeof stubFetch>): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

describe("History route", () => {
  it("paginates forward and back through the offset contract", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes("/api/history")) {
        const offset = new URL(url, "http://localhost").searchParams.get("offset");
        if (offset === "25") {
          return historyPageResponse([historyRecord({ recordId: "r2", model: "page-two-model" })], {
            total: 60,
            offset: 25,
            limit: 25,
            nextOffset: 50,
            dataVersion: 1,
          });
        }
        return historyPageResponse([historyRecord({ recordId: "r1" })], {
          total: 60,
          offset: 0,
          limit: 25,
          nextOffset: 25,
          dataVersion: 1,
        });
      }
      return {};
    });
    window.location.hash = "#/history";

    renderShell();
    await waitFor(() => expect(screen.getByTestId("history-table")).toBeTruthy());
    expect(urls(fetchMock).some((url) => url.includes("offset=0"))).toBe(true);
    expect(screen.getByText(/showing/).textContent).toContain("1–25 of 60");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(
        urls(fetchMock).some((url) => url.includes("limit=25") && url.includes("offset=25")),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId("history-table")).getAllByText("page-two-model").length,
      ).toBeGreaterThan(0),
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(urls(fetchMock).at(-1)).toContain("offset=0"));
  });

  it("disables Next on the last page and resets to page one when the page size grows", async () => {
    const fetchMock = stubFetch((url) => {
      const params = new URL(url, "http://localhost").searchParams;
      return historyPageResponse(
        [historyRecord({ recordId: `r-${params.get("limit")}-${params.get("offset")}` })],
        {
          total: 30,
          offset: Number(params.get("offset")),
          limit: Number(params.get("limit")),
          nextOffset:
            Number(params.get("limit")) === 25 && Number(params.get("offset")) === 0 ? 25 : null,
          dataVersion: 1,
        },
      );
    });
    window.location.hash = "#/history?page=2&pageSize=25";

    renderShell();
    await waitFor(() => expect(screen.getByTestId("history-table")).toBeTruthy());
    expect(screen.getByText(/of 2/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Per page"), { target: { value: "50" } });
    await waitFor(() =>
      expect(
        urls(fetchMock).some((url) => url.includes("limit=50") && url.includes("offset=0")),
      ).toBe(true),
    );
  });

  it("wires the model multi-select to the exact-match parameter with empty meaning all", async () => {
    const fetchMock = stubFetch(() =>
      historyPageResponse([
        historyRecord({ recordId: "a", model: "gpt-5" }),
        historyRecord({ recordId: "b", model: "claude-x", timestamp: "2026-08-18T12:00:00.000Z" }),
      ]),
    );
    window.location.hash = "#/history";

    renderShell();
    await waitFor(() =>
      expect(within(screen.getByTestId("history-table")).getByText("gpt-5").tagName).toBe("TD"),
    );

    // Empty selection means all: no model parameter is sent.
    expect(urls(fetchMock).every((url) => !url.includes("model="))).toBe(true);

    fireEvent.click(screen.getByText("All models"));
    fireEvent.click(screen.getByRole("checkbox", { name: "gpt-5" }));
    await waitFor(() => expect(window.location.hash).toBe("#/history?model=gpt-5"));
    await waitFor(() =>
      expect(urls(fetchMock).some((url) => url.includes("model=gpt-5"))).toBe(true),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "claude-x" }));
    await waitFor(() => expect(window.location.hash).toBe("#/history?model=gpt-5&model=claude-x"));
    expect(screen.getByText("Models (2)")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "gpt-5" }));
    await waitFor(() => expect(window.location.hash).toBe("#/history?model=claude-x"));
    fireEvent.click(screen.getByRole("checkbox", { name: "claude-x" }));
    await waitFor(() => expect(window.location.hash).toBe("#/history"));
  });

  it("sends range filters and clears them with the filter bar", async () => {
    const fetchMock = stubFetch(() => historyPageResponse([]));
    window.location.hash = "#/history";

    renderShell();
    await waitFor(() => expect(screen.getByTestId("history-empty")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-01" } });
    // The hashchange that carries the From value must land before the To
    // change reads the route state, or the From patch would be dropped.
    await waitFor(() => expect(window.location.hash).toBe("#/history?from=2026-08-01"));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-19" } });
    await waitFor(() =>
      expect(window.location.hash).toBe("#/history?from=2026-08-01&to=2026-08-19"),
    );
    expect(
      urls(fetchMock).some(
        (url) => url.includes("from=2026-08-01") && url.includes("to=2026-08-19"),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(window.location.hash).toBe("#/history"));
  });

  it("shows loading, error, and empty states without losing the shell", async () => {
    const fail = true;
    stubFetch(() => {
      throw new TypeError("network unreachable");
    });
    window.location.hash = "#/history";
    const { container } = renderShell();
    await waitFor(() => expect(screen.getByTestId("history-error")).toBeTruthy());
    expect(fail).toBe(true);
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("History");

    cleanup();
    stubFetch(() => historyPageResponse([]));
    window.location.hash = "#/history";
    renderShell();
    await waitFor(() => expect(screen.getByTestId("history-empty")).toBeTruthy());
  });

  it("keeps the Bike Overview surface intact across a route round trip", async () => {
    stubFetch((url) => {
      if (url.includes("/api/health") || url.includes("/api/summary")) {
        return url.includes("/api/health")
          ? {
              ready: true,
              server: { status: "ready", startedAt: null },
              proxy: { status: "healthy", state: "ready", updatedAt: null },
              database: {
                status: "ready",
                path: ":memory:",
                schemaVersion: 1,
                journalMode: "wal",
                recordCount: 3,
              },
              ingest: { lastSuccessfulAt: null, rejectedSidecars: 0 },
              sse: { subscribers: 1 },
            }
          : {
              reportTimezone: "America/New_York",
              startInclusive: "2026-08-22T04:00:00.000Z",
              endExclusive: "2026-08-23T04:00:00.000Z",
              inputTokens: 120,
              outputTokens: 45,
              totalTokens: 165,
              requestCount: 3,
              latestEventTimestamp: "2026-08-22T15:30:00.000Z",
              cost: { currency: "USD", amountUsd: "0.0025", catalogueVersion: "aggregate" },
              costUnavailableReason: null,
            };
      }
      return historyPageResponse([historyRecord({ recordId: "listed" })]);
    });
    window.location.hash = "#/";

    renderShell();
    await waitFor(() => expect(screen.getByText("ox-alpha-proxy admin")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("request-count").textContent).toBe("3"));
    expect(screen.getByTestId("cost-estimate").textContent).toContain("$0.0025 USD");
    expect(screen.queryByText("History")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "History" }));
    await waitFor(() => expect(screen.getByTestId("history-table")).toBeTruthy());
    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    await waitFor(() => expect(screen.getByTestId("request-count")).toBeTruthy());
  });

  it("refetches when an SSE data-version signal advances past the rendered payload", async () => {
    // The server echoes its current version in every payload; once it
    // advances past the signal, the trigger settles instead of looping.
    let servedVersion = 10;
    const fetchMock = stubFetch(() =>
      historyPageResponse([historyRecord({ recordId: "v1", model: "version-one-model" })], {
        total: 1,
        offset: 0,
        limit: 25,
        nextOffset: null,
        dataVersion: servedVersion,
      }),
    );
    window.location.hash = "#/history";
    renderShell();
    await waitFor(() =>
      expect(
        within(screen.getByTestId("history-table")).getByText("version-one-model"),
      ).toBeTruthy(),
    );
    const callsAfterLoad = fetchMock.mock.calls.length;

    const source = FakeEventSource.instances.find((entry) => entry.url === "/api/events");
    expect(source).toBeTruthy();
    servedVersion = 11;
    source?.emit("data-version", JSON.stringify({ dataVersion: 11 }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterLoad));
    // The refetch happens in place: same table, single SSE connection,
    // no document reload.
    await waitFor(() => expect(screen.getByText(/data v11/)).toBeTruthy());
    expect(screen.getByTestId("history-table")).toBeTruthy();
    expect(FakeEventSource.instances.filter((entry) => entry.url === "/api/events")).toHaveLength(
      1,
    );

    // A signal at or below the rendered version must not trigger work.
    const settledCalls = fetchMock.mock.calls.length;
    source?.emit("data-version", JSON.stringify({ dataVersion: 11 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock.mock.calls.length).toBe(settledCalls);
  });
});
