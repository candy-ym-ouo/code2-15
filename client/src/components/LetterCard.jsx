const URGENCY = {
  3: { label: '加急', className: 'urgent' },
  2: { label: '优先', className: 'priority' },
  1: { label: '常规', className: 'routine' }
};

function breakdownTitle(entry) {
  const parts = [
    `加急 ${entry.breakdown.urgencyPoints}`,
    `截止窗 ${entry.breakdown.deadlinePoints}`,
    `目的地 ${entry.breakdown.destinationPoints}`
  ];
  if (entry.overrideDelta) parts.push(`人工 ${entry.overrideDelta > 0 ? '+' : ''}${entry.overrideDelta}`);
  return `分拣分 ${entry.score}（${parts.join(' + ')}）`;
}

export default function LetterCard({ letter, islands, compact = false, priorityEntry = null, children }) {
  const islandMap = new Map(islands.map((island) => [island.id, island]));
  const origin = islandMap.get(letter.originIslandId);
  const recipient = islandMap.get(letter.recipientIslandId);
  const urgency = URGENCY[letter.urgency];

  return (
    <article className={`letter-card ${urgency.className} ${compact ? 'compact' : ''}`}>
      <div className="letter-topline">
        <span className={`urgency-tag ${urgency.className}`}>{urgency.label}</span>
        <code>{letter.id}</code>
        {priorityEntry && (
          <span className="priority-score" title={breakdownTitle(priorityEntry)}>
            #{priorityEntry.rank} · {priorityEntry.score}
          </span>
        )}
      </div>
      <h3>{letter.subject}</h3>
      <p className="letter-sender">{letter.sender}</p>
      <div className="letter-route">
        <span>{origin?.name}</span>
        <i>→</i>
        <strong>{recipient?.name}</strong>
      </div>
      <div className="letter-meta">
        <span><b>{letter.weight.toFixed(1)}</b> kg</span>
        <span>截止 <b>第{letter.deadlineDay}日 {String(letter.deadlineHour).padStart(2, '0')}:00</b></span>
      </div>
      {priorityEntry && !priorityEntry.deadlineFeasible && (
        <p className="infeasible-tag" role="note">⚠ 按今日风况已无法准时送达，将记为逾时</p>
      )}
      {priorityEntry?.overridden && (
        <p className="override-tag" role="note">
          人工覆盖 {priorityEntry.overrideDelta > 0 ? '+' : ''}{priorityEntry.overrideDelta}
        </p>
      )}
      {children && <div className="letter-actions">{children}</div>}
    </article>
  );
}
