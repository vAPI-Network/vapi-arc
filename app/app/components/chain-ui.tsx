import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { formatUnits, type Address, type Hex } from "viem";

import { EscrowState } from "~/lib/abi/escrow-v1";
import {
  ARC_EXPLORER_URL,
  USDC_DECIMALS,
  explorerAddress,
  explorerTransaction,
  type ChainRuntimeConfig,
} from "~/lib/chains";
import { makePublicClient } from "~/lib/chain-data";

export const STATE_LABELS: Record<number, string> = {
  [EscrowState.NONE]: "Unknown",
  [EscrowState.CREATED]: "Created",
  [EscrowState.LOCKED]: "Locked",
  [EscrowState.SUBMITTED]: "Submitted",
  [EscrowState.DISPUTED]: "Disputed",
  [EscrowState.RESOLVED]: "Resolved",
  [EscrowState.EXPIRED]: "Expired",
};

export function StateChip({ state }: { state: number }) {
  return (
    <span className={`state-chip state-${state}`}>
      <span className="state-chip-dot" aria-hidden="true" />
      {STATE_LABELS[state] ?? "Unknown"}
    </span>
  );
}

function durationParts(seconds: number) {
  const absolute = Math.max(0, seconds);
  const days = Math.floor(absolute / 86_400);
  const hours = Math.floor((absolute % 86_400) / 3_600);
  const minutes = Math.floor((absolute % 3_600) / 60);
  const secs = absolute % 60;
  return { days, hours, minutes, secs };
}

export function Countdown({
  deadline,
  label,
  compact = false,
}: {
  deadline: number;
  label: string;
  compact?: boolean;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const remaining = deadline - now;
  const parts = durationParts(remaining);
  if (!deadline) return null;
  if (compact) {
    return (
      <span className="countdown-compact mono">
        {remaining <= 0
          ? "elapsed"
          : `${parts.days ? `${parts.days}d ` : ""}${String(parts.hours).padStart(2, "0")}:${String(parts.minutes).padStart(2, "0")}:${String(parts.secs).padStart(2, "0")}`}
      </span>
    );
  }
  return (
    <div className={`countdown ${remaining <= 0 ? "countdown-elapsed" : ""}`}>
      <span className="countdown-label">{label}</span>
      <strong className="countdown-digits mono">
        {remaining <= 0
          ? "00:00:00"
          : `${parts.days ? `${parts.days}d ` : ""}${String(parts.hours).padStart(2, "0")}:${String(parts.minutes).padStart(2, "0")}:${String(parts.secs).padStart(2, "0")}`}
      </strong>
      <span className="countdown-status">
        {remaining <= 0 ? "Window elapsed" : "Remaining on Arc time"}
      </span>
    </div>
  );
}

export function AddressPill({
  address,
  label,
  href,
}: {
  address: Address;
  label?: string;
  href?: string;
}) {
  const [copied, setCopied] = useState(false);
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  async function copy() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }
  return (
    <span className="address-pill">
      {label && <span className="address-label">{label}</span>}
      {href ? (
        <Link className="mono address-value" to={href}>
          {short}
        </Link>
      ) : (
        <a
          className="mono address-value"
          href={explorerAddress(address)}
          target="_blank"
          rel="noreferrer"
        >
          {short}
        </a>
      )}
      <button type="button" className="copy-control" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

type TxStatus = "idle" | "pending" | "confirmed" | "error";

export function TxButton({
  children,
  execute,
  config,
  disabled,
  onConfirmed,
  className = "",
}: {
  children: ReactNode;
  execute: () => Promise<Hex>;
  config: ChainRuntimeConfig;
  disabled?: boolean;
  onConfirmed?: () => void | Promise<void>;
  className?: string;
}) {
  const [status, setStatus] = useState<TxStatus>("idle");
  const [hash, setHash] = useState<Hex>();
  const [error, setError] = useState<string>();

  async function run() {
    setStatus("pending");
    setError(undefined);
    try {
      const transactionHash = await execute();
      setHash(transactionHash);
      if (!config.mock) {
        await makePublicClient(config).waitForTransactionReceipt({
          hash: transactionHash,
        });
      }
      setStatus("confirmed");
      await onConfirmed?.();
    } catch (caught) {
      setStatus("error");
      setError(
        caught instanceof Error ? caught.message.split("\n")[0] : "Transaction failed",
      );
    }
  }

  return (
    <span className={`tx-control ${className}`}>
      <button
        type="button"
        className="action-button"
        disabled={disabled || status === "pending"}
        onClick={run}
      >
        <span>{status === "pending" ? "Confirming…" : children}</span>
        <span className={`tx-indicator tx-${status}`} aria-hidden="true" />
      </button>
      {status === "confirmed" && hash && (
        <a
          className="tx-result tx-result-confirmed"
          href={explorerTransaction(hash)}
          target="_blank"
          rel="noreferrer"
        >
          Confirmed on ArcScan
        </a>
      )}
      {status === "error" && (
        <span className="tx-result tx-result-error" title={error}>
          {error ?? "Transaction failed"}
        </span>
      )}
    </span>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="chain-empty-state">
      <span className="empty-orbit" aria-hidden="true">
        <span />
      </span>
      <h2>{title}</h2>
      <div className="empty-copy">{children}</div>
      {action && <div className="empty-action">{action}</div>}
    </section>
  );
}

export function HashField({ value, label }: { value: Hex; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="hash-field">
      <span>{label}</span>
      <button
        type="button"
        className="mono"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        }}
      >
        <span>{value}</span>
        <small>{copied ? "Copied" : "Copy"}</small>
      </button>
    </div>
  );
}

export function formatUsdc(amount: string | bigint) {
  const formatted = formatUnits(BigInt(amount), USDC_DECIMALS);
  const [whole, fraction = ""] = formatted.split(".");
  const trimmedFraction = fraction.slice(0, 6).replace(/0+$/, "");
  return `${BigInt(whole).toLocaleString("en-US")}${trimmedFraction ? `.${trimmedFraction}` : ""} USDC`;
}

export function ChainError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="chain-warning" role="status">
      <strong>Arc read interrupted</strong>
      <span>The last verified snapshot stays visible. The next poll will retry.</span>
    </div>
  );
}

export function ArcLink({ children }: { children: ReactNode }) {
  return (
    <a href={ARC_EXPLORER_URL} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export function usePolling<T>(
  initial: T,
  load: () => Promise<T>,
  interval: number,
) {
  const [value, setValue] = useState(initial);
  const stableLoad = useMemo(() => load, [load]);
  useEffect(() => {
    let active = true;
    if (interval <= 0) return;
    const poll = () => {
      void stableLoad().then((next) => {
        if (active) setValue(next);
      });
    };
    const timer = window.setInterval(poll, interval);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [interval, stableLoad]);
  return [value, setValue] as const;
}
