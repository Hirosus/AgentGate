import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentGate — Incident Triage & Eval Operations Console",
  description:
    "Live HMAC-signed webhook verification, atomic idempotency defense, read-only MCP diagnostic execution, and automated CI eval benchmarking.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en" data-theme="dark">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
