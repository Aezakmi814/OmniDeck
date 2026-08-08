export function Status({ good, label, muted = false }: { good: boolean; label: string; muted?: boolean }) {
  return (
    <span className={`status ${muted ? "status-muted" : good ? "status-good" : "status-bad"}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}
