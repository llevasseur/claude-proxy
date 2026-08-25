import type { Advice } from '@agent-proxy/claude-core';

const LABEL = { high: 'High', warn: 'Warn', info: 'Info' } satisfies Record<Advice['severity'], string>;

export function AdviceCard({ advice }: { advice: Advice }) {
  return (
    <div className={`card advice sev-${advice.severity}`}>
      <div className='advice-head'>
        <span className={`badge sev-${advice.severity}`}>{LABEL[advice.severity]}</span>
        <h3>{advice.title}</h3>
      </div>
      <p>{advice.detail}</p>
      {advice.metric && <div className='advice-metric muted'>metric: {advice.metric}</div>}
    </div>
  );
}
