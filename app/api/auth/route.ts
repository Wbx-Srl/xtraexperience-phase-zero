import { NextRequest, NextResponse } from "next/server";
import { kv } from "@/lib/kv";

/**
 * GET /api/auth?shop=xtrawine.myshopify.com
 * Entry point OAuth — se il token esiste già, redirige direttamente all'Admin.
 * Altrimenti avvia il flusso OAuth.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const shop = req.nextUrl.searchParams.get("shop");
  if (!shop || !shop.endsWith(".myshopify.com")) {
    return NextResponse.json({ error: "Parametro shop mancante o non valido" }, { status: 400 });
  }

  // Se già installata, non rifare OAuth
  const existing = await kv.get(`shop:${shop}`);
  if (existing) {
    return NextResponse.redirect(`https://${shop}/admin`);
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID!;
  const redirectUri = `${process.env.APP_BASE_URL}/api/auth/callback`;
  const scopes = [
    "read_orders",
    "write_orders",
    "read_products",
    "write_discounts",
    "write_price_rules",
  ].join(",");

  const state = Buffer.from(`${Date.now()}`).toString("hex");

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${clientId}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  return NextResponse.redirect(authUrl);
}
