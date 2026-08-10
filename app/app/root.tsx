import { useState } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import { AddressPill, ArcLink } from "./components/chain-ui";
import { ARC_CHAIN_ID, getServerChainConfig } from "./lib/chains";
import { useWallet, WalletProvider } from "./lib/wallet";
import "./app.css";

export function loader() {
  return { config: getServerChainConfig() };
}

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico" },
  {
    rel: "preload",
    href: "/fonts/SpaceGrotesk-Regular.woff2",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
  {
    rel: "preload",
    href: "/fonts/SpaceGrotesk-Medium.woff2",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
];

export const meta: Route.MetaFunction = () => [
  { title: "vAPI Work + Verify · Arc Testnet" },
  {
    name: "description",
    content:
      "Chain-native work escrow, dispute resolution, and reputation on Arc Testnet.",
  },
];

const navClass = ({ isActive }: { isActive: boolean }) =>
  `nav-link ${isActive ? "nav-link-active" : ""}`;

function WalletControl() {
  const wallet = useWallet();
  const [error, setError] = useState<string>();
  const wrongChain = wallet.connected && wallet.chainId !== ARC_CHAIN_ID;

  if (!wallet.connected) {
    return (
      <div className="wallet-slot">
        <button
          type="button"
          className="wallet-connect"
          onClick={() =>
            void wallet.connect().catch((caught) =>
              setError(caught instanceof Error ? caught.message : "Wallet connection failed"),
            )
          }
        >
          {wallet.connecting ? "Opening wallet…" : "Connect wallet"}
        </button>
        {error && <span className="wallet-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="wallet-control">
      <div className="wallet-identity">
        <AddressPill address={wallet.account!} />
        <span className="role-badge">Wallet</span>
        {wallet.isArbiter && <span className="role-badge role-arbiter">Reviewer</span>}
      </div>
      <div className="wallet-actions">
        {wrongChain && (
          <button
            type="button"
            className="network-switch"
            onClick={() => void wallet.switchToArc().catch(() => undefined)}
          >
            Switch to Arc
          </button>
        )}
        <button
          type="button"
          className="actor-switch"
          onClick={() => void wallet.switchActor().catch(() => undefined)}
        >
          Change actor
        </button>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <NavLink to="/" className="wordmark" aria-label="vAPI Work and Verify home">
          <img
            src="/brand/vapi-wordmark-on-light.png"
            alt="vAPI"
            width="469"
            height="154"
          />
          <span>Work + Verify</span>
        </NavLink>
        <nav aria-label="Primary navigation" className="primary-nav">
          <NavLink to="/" end className={navClass}>
            Marketplace
          </NavLink>
          <NavLink to="/arbiters" className={navClass}>
            Disputes
          </NavLink>
          <NavLink to="/reputation" className={navClass}>
            Reputation
          </NavLink>
        </nav>
        <WalletControl />
      </div>
      <div className="brand-strip" aria-hidden="true" />
    </header>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="shell footer-inner">
        <span className="network-lockup">
          <span className="network-dot" aria-hidden="true" />
          Arc Testnet · Chain ID {ARC_CHAIN_ID}
        </span>
        <span>USDC settles work and pays network gas.</span>
        <ArcLink>Open ArcScan</ArcLink>
      </div>
    </footer>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { config } = useLoaderData<typeof loader>();
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <Meta />
        <Links />
      </head>
      <body>
        <WalletProvider config={config}>
          <Header />
          <main className="shell main-content">{children}</main>
          <Footer />
        </WalletProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Arc could not answer this request";
  let detail = "The next chain read may succeed. Return to the marketplace and try again.";
  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      title = "Order not found";
      detail = "No registered escrow was found at that address.";
    } else if (error.status === 400) {
      title = "That address is not valid";
      detail = "Use a complete 0x-prefixed EVM address.";
    }
  }
  return (
    <section className="error-state" aria-labelledby="error-title">
      <span className="error-code">Chain read</span>
      <h1 id="error-title">{title}</h1>
      <p>{detail}</p>
      <NavLink to="/" className="action-button">
        Back to the marketplace
      </NavLink>
    </section>
  );
}
