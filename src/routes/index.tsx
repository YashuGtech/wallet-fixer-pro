import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

// The mini app itself is the original static bundle served from /fap/.
// "/" forwards there, keeping any ?ref=CODE referral query intact.
export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "FAP Rewards — Scratch & Earn Telegram Mini App" },
      {
        name: "description",
        content:
          "Refer friends, scratch cards and withdraw rewards to UPI or gift vouchers inside the FAP Rewards Telegram Mini App.",
      },
      { property: "og:title", content: "FAP Rewards — Scratch & Earn" },
      {
        property: "og:description",
        content: "Invite friends, scratch cards and cash out — right inside Telegram.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  useEffect(() => {
    window.location.replace(`/fap/index.html${window.location.search}${window.location.hash}`);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-center">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">FAP Rewards</h1>
        <p className="mt-2 text-sm text-muted-foreground">Opening the Mini App…</p>
        <a href="/fap/index.html" className="mt-4 inline-block text-sm underline">
          Tap here if it doesn&apos;t open
        </a>
      </div>
    </div>
  );
}
