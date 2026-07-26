import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { ChatSessionProvider } from "./chat-session";
import { router } from "./router";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Outside the router on purpose: a chat started on the Sessions page navigates to
          its own session page, and the conversation has to survive that. */}
      <ChatSessionProvider>
        <RouterProvider router={router} />
      </ChatSessionProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
