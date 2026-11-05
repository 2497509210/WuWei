export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <div className="brand-mark">物</div>
      <div className="brand-text">
        <strong>物位</strong>
        {!compact && <span>家里每件东西的位置</span>}
      </div>
    </div>
  );
}
