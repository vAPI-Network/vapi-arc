import {
  isRouteErrorResponse,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&display=swap",
  },
];

export const meta: Route.MetaFunction = () => [
  { title: "vAPI Trust Network · Auditable ERC-8183 evaluation" },
  {
    name: "description",
    content:
      "On-chain AI and human evaluation history for ERC-8183 jobs on Arc Testnet.",
  },
];

const navClass = ({ isActive }: { isActive: boolean }) =>
  `nav-link ${isActive ? "nav-link-active" : ""}`;

function Header() {
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <NavLink to="/" className="wordmark" aria-label="vAPI Trust Network home">
          vAPI Trust Network<span aria-hidden="true">.</span>
        </NavLink>
        <nav aria-label="Primary navigation" className="primary-nav">
          <NavLink to="/" end className={navClass}>
            Feed
          </NavLink>
          <NavLink to="/review" className={navClass}>
            Review
          </NavLink>
          <a
            href="/api/reputation/0x0000000000000000000000000000000000000000"
            className="nav-link"
          >
            API
          </a>
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="shell footer-inner">
        <span>Arc Testnet</span>
        <span aria-hidden="true">·</span>
        <a
          href="https://testnet.arcscan.app/address/0x0747EEf0706327138c69792bF28Cd525089e4583"
          target="_blank"
          rel="noreferrer"
        >
          AgenticCommerce <span className="mono">0x0747…4583</span>
        </a>
      </div>
    </footer>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <Meta />
        <Links />
      </head>
      <body>
        <Header />
        <main className="shell main-content">{children}</main>
        <Footer />
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
  let title = "Chain data is temporarily unavailable";
  let detail =
    "The Arc Testnet RPC did not return a usable response. Please try again in a moment.";

  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Page not found" : title;
    if (error.status === 400) {
      title = "That address is not valid";
      detail = "Enter a complete 0x-prefixed Ethereum address and try again.";
    }
  }

  return (
    <section className="error-state" aria-labelledby="error-title">
      <p className="eyebrow">Arc Testnet</p>
      <h1 id="error-title">{title}</h1>
      <p>{detail}</p>
      <NavLink to="/" className="button">
        Back to feed
      </NavLink>
    </section>
  );
}
