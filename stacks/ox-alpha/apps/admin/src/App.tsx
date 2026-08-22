import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OverviewPage } from "./OverviewPage";
import { useLiveOverview } from "./overview/useLiveOverview";

const queryClient = new QueryClient();

function Overview() {
  const live = useLiveOverview();
  return <OverviewPage live={live} />;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Overview />
    </QueryClientProvider>
  );
}
