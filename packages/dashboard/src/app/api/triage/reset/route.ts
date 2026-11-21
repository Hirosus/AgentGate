import { NextResponse } from "next/server";
import { isSameOriginRequest, LEDGER_COOKIE_NAME } from "@/lib/triageEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-origin request forbidden." }, { status: 403 });
  }

  const res = NextResponse.json({
    cleared: true,
    claimedKeyCount: 0,
  });
  res.cookies.set(LEDGER_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/api/triage",
    maxAge: 0,
  });
  return res;
}
