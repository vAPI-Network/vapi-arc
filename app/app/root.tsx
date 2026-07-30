import {
  isRouteErrorResponse,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [];

export const meta: Route.MetaFunction = () => [
  { title: "vAPI Trust Network · Arc Testnet" },
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
            Jobs
          </NavLink>
          <NavLink to="/demo" className={navClass}>
            Demo
          </NavLink>
          <NavLink to="/review" className={navClass}>
            Reviews
          </NavLink>
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
        <span aria-hidden="true">·</span>
        <a href="/openapi.json">OpenAPI</a>
      </div>
    </footer>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const presenterMode =
    location.pathname === "/demo" &&
    new URLSearchParams(location.search).get("present") === "1";

  return (
    <html lang="en" className={presenterMode ? "presenter-mode" : undefined}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <Meta />
        <Links />
      </head>
      <body>
        {!presenterMode && <Header />}
        <main
          className={
            presenterMode
              ? "shell main-content presenter-main"
              : "shell main-content"
          }
        >
          {children}
        </main>
        {!presenterMode && <Footer />}
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
        Back to jobs
      </NavLink>
    </section>
  );
}
