import { useState } from "react";

export const EXPLORER_BASE = "https://testnet.arcscan.app";

export function SetupBanner() {
  return (
    <aside className="setup-banner" role="status">
      <span className="setup-mark" aria-hidden="true">
        ◇
      </span>
      <div>
        <strong>EvaluationRouter is not configured</strong>
        <p>
          Set <span className="mono">ROUTER_ADDRESS</span> after deployment.
          The dashboard will begin indexing public Arc Testnet events
          automatically.
        </p>
      </div>
    </aside>
  );
}

export function NetworkPill() {
  return (
    <span className="network-pill">
      <span className="network-dot" aria-hidden="true" />
      Arc Testnet · 5042002
    </span>
  );
}

export function ShortHash({
  value,
  start = 8,
  end = 6,
}: {
  value: string;
  start?: number;
  end?: number;
}) {
  const [copied, setCopied] = useState(false);
  const display =
    value.length > start + end + 1
      ? `${value.slice(0, start)}…${value.slice(-end)}`
      : value;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className="hash-button"
      onClick={copy}
      title={copied ? "Copied" : `Copy ${value}`}
      aria-label={copied ? "Copied to clipboard" : `Copy ${value}`}
    >
      {copied ? "Copied" : display}
    </button>
  );
}

const statusClass: Record<string, string> = {
  Completed: "status-completed",
  Rejected: "status-rejected",
  Submitted: "status-pending",
  Expired: "status-pending",
  Escalated: "status-pending",
  Open: "status-neutral",
  Funded: "status-neutral",
};

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`status-chip ${statusClass[status] ?? "status-neutral"}`}>
      {status}
    </span>
  );
}

export function TxLink({
  hash,
  children,
}: {
  hash: string;
  children: React.ReactNode;
}) {
  return (
    <a
      className="subtle-link"
      href={`${EXPLORER_BASE}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}
