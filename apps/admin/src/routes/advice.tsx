import { useQuery } from "@tanstack/react-query";
import { getSummary } from "../api";
import { AdviceCard } from "../components/AdviceCard";
import { QueryState } from "../components/QueryState";

export function AdvicePage() {
  const query = useQuery({ queryKey: ["summary"], queryFn: () => getSummary() });
  const advice = query.data?.advice ?? [];

  return (
    <section>
      <div className="pagehead">
        <h1>Advice</h1>
        <div className="muted">{query.data?.digest.date} · deterministic coaching from today's digest</div>
      </div>

      <QueryState isLoading={query.isLoading} error={query.error}>
        <div className="advice-list wide">
          {advice.map((a) => (
            <AdviceCard key={a.id} advice={a} />
          ))}
        </div>
      </QueryState>
    </section>
  );
}
