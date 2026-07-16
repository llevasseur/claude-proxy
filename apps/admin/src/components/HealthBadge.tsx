import { useQuery } from "@tanstack/react-query";
import { getHealth } from "../api";

export function HealthBadge() {
  const { data, isError } = useQuery({ queryKey: ["health"], queryFn: getHealth, refetchInterval: 30_000 });
  const ok = !isError && data?.ok;
  const title = data ? `${data.logDir}${data.sidecarCount != null ? ` · ${data.sidecarCount} sidecars` : ""}` : "API unreachable";
  return (
    <div className="health" title={title}>
      <span className={`dot ${ok ? "ok" : "bad"}`} />
      {data?.sidecarCount != null ? `${data.sidecarCount.toLocaleString()} logs` : ok ? "connected" : "offline"}
    </div>
  );
}
