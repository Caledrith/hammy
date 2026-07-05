import type { Metadata } from "next";
import Link from "next/link";
import { runSync } from "./actions";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hammy Print Queue",
  description: "Shopify orders to 3D print job queue",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <span className="brand">HAMMY</span>
          <Link href="/plates">Plates</Link>
          <Link href="/queue">Queue</Link>
          <Link href="/review">Review</Link>
          <Link href="/orders">Orders</Link>
          <span className="spacer" />
          <form action={runSync}>
            <button type="submit" className="primary">
              Sync now
            </button>
          </form>
        </nav>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
