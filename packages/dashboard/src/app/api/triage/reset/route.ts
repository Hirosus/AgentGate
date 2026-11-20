import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  getDemoIdempotencyMap,
  LEDGER_COOKIE_NAME,
  parseSignedLedgerCookie,
  resolveDemoSigningSecret,
} from "@/lib/triageEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const secret = resolveDemoSigningSecret();
  const cookieStore = await cookies();
  const nowSec = Math.floor(Date.now() / 1000);
  const cookieKeys = parseSignedLedgerCookie(
    cookieStore.get(LEDGER_COOKIE_NAME)?.value,
    secret,
    nowSec,
  );

  const memMap = getDemoIdempotencyMap();
  for (const key of Object.keys(cookieKeys)) {
    memMap.delete(key);
  }
  if (Object.keys(cookieKeys).length === 0) {
    memMap.clear();
  }

  const res = NextResponse.json({
    cleared: true,
    claimedKeyCount: 0,
  });
  res.cookies.set(LEDGER_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
